use std::collections::HashMap;
use std::sync::{
    OnceLock, RwLock,
    atomic::{AtomicI32, AtomicU32, Ordering},
};

use serde::{Deserialize, Serialize};
use typst::diag::{FileError, FileResult, SourceDiagnostic, eco_format};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, World};
use wasm_bindgen::prelude::*;

const STATUS_PENDING: u32 = 1;
const STATUS_READY: u32 = 2;
const STATUS_ERROR: u32 = 3;

const REQUEST_KIND_FILE: u32 = 3;
const BUFFER_SIZE: usize = 10 * 1024 * 1024; // 10 MB
const WAIT_TIMEOUT_MS: f64 = 30000.0; // 30 second timeout for resource requests

#[link(wasm_import_module = "bridge")]
unsafe extern "C" {
    fn notify_host();
}

#[repr(C)]
pub struct ResourceRequest {
    signal: AtomicI32,       // offset 0
    status: AtomicU32,       // offset 4
    request_kind: u32,       // offset 8
    path_len: u32,           // offset 12
    path_data: [u8; 1024],   // offset 16
    result_len: u32,         // offset 1040
    error_code: u32,         // offset 1044
    data: [u8; BUFFER_SIZE], // offset 1048
}

// Thread-safe global storage for the bridge pointer using OnceLock
static BRIDGE: OnceLock<*mut ResourceRequest> = OnceLock::new();

// Safety: The pointer is only written once during init_bridge and read thereafter.
// The ResourceRequest uses atomic operations for thread-safe access.
unsafe impl Send for ResourceRequestWrapper {}
unsafe impl Sync for ResourceRequestWrapper {}
struct ResourceRequestWrapper(*mut ResourceRequest);

#[wasm_bindgen]
pub fn init_bridge() -> *mut ResourceRequest {
    let request = Box::new(ResourceRequest {
        signal: AtomicI32::new(0),
        status: AtomicU32::new(STATUS_READY), // Start as READY (idle)
        request_kind: 0,
        path_len: 0,
        path_data: [0; 1024],
        result_len: 0,
        error_code: 0,
        data: [0; BUFFER_SIZE],
    });
    let ptr = Box::into_raw(request);
    let _ = BRIDGE.set(ptr);
    ptr
}

pub struct ResourceBridge;

impl ResourceBridge {
    fn request_ptr() -> Result<*mut ResourceRequest, String> {
        BRIDGE
            .get()
            .copied()
            .ok_or_else(|| "Bridge not initialized".to_string())
    }

    pub fn request_file(path: &str) -> Result<Vec<u8>, String> {
        let ptr = Self::request_ptr()?;
        // Safety: The pointer is valid as it was created via Box::into_raw in init_bridge
        // and the ResourceRequest uses atomic operations for thread-safe field access.
        let request = unsafe { &mut *ptr };

        let path_bytes = path.as_bytes();
        if path_bytes.len() > 1024 {
            return Err("Path too long".to_string());
        }

        request.path_data[..path_bytes.len()].copy_from_slice(path_bytes);
        request.path_len = path_bytes.len() as u32;
        request.request_kind = REQUEST_KIND_FILE;

        request
            .signal
            .store(STATUS_PENDING as i32, Ordering::Release);
        request.status.store(STATUS_PENDING, Ordering::Release);

        unsafe {
            notify_host();
        }

        let memory = wasm_bindgen::memory();
        let buffer = js_sys::Reflect::get(&memory, &JsValue::from_str("buffer"))
            .map_err(|_| "Failed to get memory buffer".to_string())?;
        let view = js_sys::Int32Array::new(&buffer);

        // Calculate index of signal in Int32Array
        // signal is at offset 0 relative to struct.
        // We need ptr / 4 to get Int32 index
        let ptr_val = ptr as u32;
        let signal_idx = ptr_val / 4;

        loop {
            // Use timeout to prevent infinite blocking
            match js_sys::Atomics::wait_with_timeout(
                &view,
                signal_idx,
                STATUS_PENDING as i32,
                WAIT_TIMEOUT_MS,
            ) {
                Ok(result) => {
                    // Check if we timed out
                    let result_str = result.as_string().unwrap_or_default();
                    if result_str == "timed-out" {
                        return Err(format!(
                            "Resource request timed out after {}ms: {}",
                            WAIT_TIMEOUT_MS, path
                        ));
                    }
                }
                Err(_) => return Err("Atomics wait failed".to_string()),
            }

            let status = request.status.load(Ordering::Acquire);
            if status != STATUS_PENDING {
                break;
            }
        }

        let status = request.status.load(Ordering::Acquire);
        if status == STATUS_ERROR {
            return Err(format!(
                "Resource fetch error (code {}): {}",
                request.error_code, path
            ));
        }

        let len = request.result_len as usize;
        if len > BUFFER_SIZE {
            return Err(format!(
                "Result too large for buffer ({} > {})",
                len, BUFFER_SIZE
            ));
        }

        // Copy from data buffer
        let data = &request.data[..len];
        Ok(data.to_vec())
    }
}

#[wasm_bindgen]
pub struct TypstCompiler {
    library: LazyHash<Library>,
    fonts: Vec<Font>,
    font_book: LazyHash<FontBook>,
    sources: RwLock<HashMap<FileId, Source>>,
    files: RwLock<HashMap<FileId, Bytes>>,
    main_id: Option<FileId>,
}

#[wasm_bindgen]
impl TypstCompiler {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let fonts = Vec::new();
        let font_book = FontBook::from_fonts(&fonts);
        Self {
            library: LazyHash::new(Library::default()),
            fonts,
            font_book: LazyHash::new(font_book),
            sources: RwLock::new(HashMap::new()),
            files: RwLock::new(HashMap::new()),
            main_id: None,
        }
    }

    pub fn add_font(&mut self, data: &[u8]) {
        let bytes = Bytes::new(data.to_vec());
        if let Some(font) = Font::iter(bytes).next() {
            self.fonts.push(font);
            self.font_book = LazyHash::new(FontBook::from_fonts(&self.fonts));
        }
    }

    pub fn add_source(&mut self, path: &str, text: &str) {
        let id = FileId::new(None, VirtualPath::new(path));
        let source = Source::new(id, text.to_string());
        self.sources
            .write()
            .expect("Failed to acquire write lock on sources")
            .insert(id, source);
    }

    pub fn add_file(&mut self, path: &str, data: &[u8]) {
        let id = FileId::new(None, VirtualPath::new(path));
        let bytes = Bytes::new(data.to_vec());
        self.files
            .write()
            .expect("Failed to acquire write lock on files")
            .insert(id, bytes);
    }

    pub fn set_main(&mut self, path: &str) {
        let id = FileId::new(None, VirtualPath::new(path));
        self.main_id = Some(id);
    }

    pub fn compile(&mut self) -> Result<String, JsValue> {
        let _main_id = self
            .main_id
            .ok_or_else(|| JsValue::from_str("Main file not set"))?;

        let result = typst::compile(self);

        match result.output {
            Ok(document) => {
                let svg = typst_svg::svg_merged(&document, Default::default());
                Ok(svg)
            }
            Err(errors) => {
                let diagnostics: Vec<WasmDiagnostic> = errors
                    .iter()
                    .map(|err| WasmDiagnostic::from_source_diagnostic(err, self))
                    .collect();
                Err(serde_wasm_bindgen::to_value(&diagnostics)?)
            }
        }
    }
}

impl World for TypstCompiler {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.font_book
    }

    fn main(&self) -> FileId {
        self.main_id
            .expect("main() called before set_main() - this is a bug in the compiler usage")
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if let Some(source) = self
            .sources
            .read()
            .expect("Failed to acquire read lock on sources")
            .get(&id)
        {
            return Ok(source.clone());
        }

        let bytes = self.file(id)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| FileError::InvalidUtf8)?;
        let source = Source::new(id, text.to_string());

        self.sources
            .write()
            .expect("Failed to acquire write lock on sources")
            .insert(id, source.clone());
        Ok(source)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if let Some(bytes) = self
            .files
            .read()
            .expect("Failed to acquire read lock on files")
            .get(&id)
        {
            return Ok(bytes.clone());
        }

        let path = if let Some(package) = id.package() {
            format!(
                "@{}/{}:{}/{}",
                package.namespace,
                package.name,
                package.version,
                id.vpath().as_rootless_path().to_string_lossy()
            )
        } else {
            id.vpath().as_rootless_path().to_string_lossy().to_string()
        };

        match ResourceBridge::request_file(&path) {
            Ok(data) => {
                let bytes = Bytes::new(data);
                self.files
                    .write()
                    .expect("Failed to acquire write lock on files")
                    .insert(id, bytes.clone());
                Ok(bytes)
            }
            Err(e) => Err(FileError::Other(Some(eco_format!("{}", e)))),
        }
    }

    fn font(&self, id: usize) -> Option<Font> {
        self.fonts.get(id).cloned()
    }

    /// Returns the current date.
    /// Note: Currently returns a fixed date (1970-01-01) as the WASM environment
    /// doesn't have direct access to the system clock. For accurate dates,
    /// pass the date from the host environment.
    fn today(&self, _offset: Option<i64>) -> Option<Datetime> {
        // TODO: Accept date from host via the bridge
        Datetime::from_ymd(1970, 1, 1)
    }
}

#[derive(Serialize, Deserialize)]
pub struct WasmDiagnostic {
    pub message: String,
    pub severity: String,
    pub start: Option<usize>,
    pub end: Option<usize>,
    pub line: Option<usize>,
    pub column: Option<usize>,
}

impl WasmDiagnostic {
    fn from_source_diagnostic(diag: &SourceDiagnostic, world: &dyn World) -> Self {
        let mut line = None;
        let mut column = None;
        let mut start = None;
        let mut end = None;

        if let Some(span) = diag.span.id() {
            if let Some(source) = world.source(span).ok() {
                if let Some(range) = source.range(diag.span) {
                    start = Some(range.start);
                    end = Some(range.end);
                    line = Some(source.byte_to_line(range.start).unwrap_or(0));
                    column = Some(source.byte_to_column(range.start).unwrap_or(0));
                }
            }
        }

        Self {
            message: diag.message.to_string(),
            severity: format!("{:?}", diag.severity).to_lowercase(),
            start,
            end,
            line,
            column,
        }
    }
}
