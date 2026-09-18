//! PDF export on macOS: WKWebView's own print operation, pointed at a file instead of a
//! printer, with every panel turned off.
//!
//! The page itself decides what gets printed (the `#print` pages and the print stylesheet in
//! the web layer); this only fixes the sheet: A4, no margins — the pages carry their own
//! margins, so the paper colour reaches the edges — and one page of web content per sheet.

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::mpsc::Sender;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject};
use objc2::{
    define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{
    NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSPrintingPaginationMode,
    NSWindow,
};
use objc2_foundation::{NSString, NSURL};
use objc2_web_kit::WKWebView;

/// A4 in PostScript points.
const A4: (f64, f64) = (595.28, 841.89);

define_class!(
    // SAFETY: NSObject has no subclassing requirements, and this class does not implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "IroriPdfDone"]
    #[ivars = RefCell<Option<Sender<bool>>>]
    struct Done;

    impl Done {
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(&self, _op: &NSPrintOperation, success: Bool, _info: *mut c_void) {
            if let Some(tx) = self.ivars().borrow_mut().take() {
                let _ = tx.send(success.as_bool());
            }
        }
    }
);

impl Done {
    fn new(mtm: MainThreadMarker, tx: Sender<bool>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(RefCell::new(Some(tx)));
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    /// The operation does not retain its delegate; the latest one is parked here (main thread
    /// only) until the next export replaces it.
    static DONE: RefCell<Option<Retained<Done>>> = const { RefCell::new(None) };
}

/// Start writing the webview's print rendering to `path`. Must run on the main thread;
/// `tx` receives whether it succeeded once the file is written.
///
/// # Safety
/// `webview` and `window` must be the live WKWebView / NSWindow of one Tauri webview window.
pub unsafe fn start(webview: *mut c_void, window: *mut c_void, path: &str, tx: Sender<bool>) {
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = tx.send(false);
        return;
    };
    let webview = &*(webview as *const WKWebView);
    let window = &*(window as *const NSWindow);

    let info = NSPrintInfo::init(NSPrintInfo::alloc());
    info.setPaperSize(objc2_foundation::NSSize::new(A4.0, A4.1));
    info.setTopMargin(0.0);
    info.setBottomMargin(0.0);
    info.setLeftMargin(0.0);
    info.setRightMargin(0.0);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
    info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
    info.setJobDisposition(NSPrintSaveJob);
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let dict = info.dictionary();
    let _: () = msg_send![&*dict, setObject: &*url, forKey: NSPrintJobSavingURL];

    let op = webview.printOperationWithPrintInfo(&info);
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    // WKWebView's print view starts out zero-sized; without a frame the operation renders
    // nothing (blank pages)
    if let Some(view) = op.view() {
        view.setFrame(webview.frame());
    }

    let done = Done::new(mtm, tx);
    op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
        window,
        Some(&*(Retained::as_ptr(&done) as *const AnyObject)),
        Some(sel!(printOperationDidRun:success:contextInfo:)),
        std::ptr::null_mut(),
    );
    DONE.with(|slot| *slot.borrow_mut() = Some(done));
}
