use super::geometry::{Rect, SnapState};
use super::resize::{ResizeEdge, ResizeSnapState, adjacent};
use std::{cell::RefCell, mem::size_of, sync::mpsc};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM},
    Graphics::{
        Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute},
        Gdi::{ClientToScreen, EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO},
    },
    System::Threading::GetCurrentThreadId,
    UI::{
        HiDpi::GetDpiForWindow,
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            EnumThreadWindows, GetClientRect, GetCursorPos, GetPropW, GetWindowRect, IsIconic,
            IsWindowVisible, RemovePropW, SetPropW, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVING,
            WM_NCDESTROY, WM_SIZING, WMSZ_BOTTOM, WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT,
            WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT,
        },
    },
};

const SUBCLASS_ID: usize = 0x434f5a59;
const STATE_PROPERTY: *const u16 = windows_sys::core::w!("CozyNotes.Snapping.State");

#[derive(Default)]
struct Drag {
    anchor: Option<(f64, f64)>,
    snap: SnapState,
    resize: Option<ResizeDrag>,
}

struct ResizeDrag {
    offsets: (f64, f64, f64, f64),
    neighbors: Vec<HWND>,
    snap: ResizeSnapState,
}

pub(super) fn attach(window: &tauri::WebviewWindow) -> Result<(), String> {
    let handle = window.hwnd().map_err(|error| error.to_string())?.0 as usize;
    let (sender, receiver) = mpsc::sync_channel(1);
    window
        .run_on_main_thread(move || {
            // Subclass installation and all callback state belong to the window's UI thread.
            let result = unsafe { install(handle as HWND) };
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver.recv().map_err(|error| error.to_string())?
}

pub(super) fn client_offset(window: &tauri::WebviewWindow) -> Result<(i32, i32), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?.0;
    let outer = outer_rect(hwnd).ok_or("Couldn't read the note's window bounds.")?;
    let client = client_rect(hwnd).ok_or("Couldn't read the note's visible bounds.")?;
    Ok((client.left - outer.left, client.top - outer.top))
}

unsafe fn install(hwnd: HWND) -> Result<(), String> {
    if !unsafe { GetPropW(hwnd, STATE_PROPERTY) }.is_null() {
        return Ok(());
    }
    let state = Box::into_raw(Box::new(RefCell::new(Drag::default())));
    if unsafe { SetPropW(hwnd, STATE_PROPERTY, state.cast()) } == 0
        || unsafe { SetWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID, state as usize) } == 0
    {
        unsafe {
            RemovePropW(hwnd, STATE_PROPERTY);
            drop(Box::from_raw(state));
        }
        return Err("Couldn't enable note snapping.".into());
    }
    Ok(())
}

unsafe extern "system" fn subclass(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        unsafe {
            RemoveWindowSubclass(hwnd, Some(subclass), SUBCLASS_ID);
            RemovePropW(hwnd, STATE_PROPERTY);
            drop(Box::from_raw(data as *mut RefCell<Drag>));
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
    }
    if matches!(
        message,
        WM_ENTERSIZEMOVE | WM_MOVING | WM_SIZING | WM_EXITSIZEMOVE
    ) {
        // Native callbacks must not unwind through the Windows message dispatcher.
        let handled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let state = unsafe { &*(data as *const RefCell<Drag>) };
            let Ok(mut drag) = state.try_borrow_mut() else {
                return false;
            };
            match message {
                WM_ENTERSIZEMOVE => {
                    *drag = Drag::default();
                    if let (Some(outer), Some(cursor)) = (outer_rect(hwnd), cursor_position()) {
                        let scale = scale(hwnd);
                        drag.anchor = Some((
                            f64::from(cursor.x - outer.left) / scale,
                            f64::from(cursor.y - outer.top) / scale,
                        ));
                        if let Some(client) = client_rect(hwnd) {
                            drag.resize = Some(ResizeDrag {
                                offsets: (
                                    f64::from(cursor.x - outer.left) / scale,
                                    f64::from(cursor.y - outer.top) / scale,
                                    f64::from(outer.right - cursor.x) / scale,
                                    f64::from(outer.bottom - cursor.y) / scale,
                                ),
                                neighbors: note_targets(hwnd)
                                    .into_iter()
                                    .filter(|note| adjacent(client, note.rect, scale))
                                    .map(|note| note.hwnd)
                                    .collect(),
                                snap: ResizeSnapState::default(),
                            });
                        }
                    }
                    false
                }
                WM_EXITSIZEMOVE => {
                    *drag = Drag::default();
                    false
                }
                WM_MOVING if lparam != 0 => {
                    let proposed = unsafe { &mut *(lparam as *mut RECT) };
                    move_rect(hwnd, &mut drag, proposed)
                }
                WM_SIZING if lparam != 0 => {
                    let Some(edge) = sizing_edge(wparam) else {
                        return false;
                    };
                    let proposed = unsafe { &mut *(lparam as *mut RECT) };
                    resize_rect(hwnd, &mut drag, edge, proposed)
                }
                _ => false,
            }
        }))
        .unwrap_or(false);
        if handled {
            return 1;
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

fn move_rect(hwnd: HWND, drag: &mut Drag, proposed: &mut RECT) -> bool {
    let (Some((anchor_x, anchor_y)), Some(cursor), Some(outer), Some(client)) = (
        drag.anchor,
        cursor_position(),
        outer_rect(hwnd),
        client_rect(hwnd),
    ) else {
        return false;
    };
    let scale = scale(hwnd);
    let width = proposed.right - proposed.left;
    let height = proposed.bottom - proposed.top;
    if width <= 0 || height <= 0 {
        return false;
    }
    // Use the original pointer offset so repeated magnetic adjustments cannot trap the cursor.
    let left = cursor.x - (anchor_x * scale).round() as i32;
    let top = cursor.y - (anchor_y * scale).round() as i32;
    let desired = Rect {
        left: left + client.left - outer.left,
        top: top + client.top - outer.top,
        right: left + width - (outer.right - client.right),
        bottom: top + height - (outer.bottom - client.bottom),
    };
    let mut areas = Vec::new();
    unsafe {
        EnumDisplayMonitors(
            std::ptr::null_mut(),
            std::ptr::null(),
            Some(collect_monitor),
            &mut areas as *mut Vec<Rect> as LPARAM,
        );
    }
    let notes: Vec<_> = note_targets(hwnd)
        .into_iter()
        .map(|note| note.rect)
        .collect();
    let snapped = drag.snap.apply(desired, &areas, &notes, scale);
    proposed.left = left + snapped.left - desired.left;
    proposed.top = top + snapped.top - desired.top;
    proposed.right = proposed.left + width;
    proposed.bottom = proposed.top + height;
    true
}

fn sizing_edge(edge: WPARAM) -> Option<ResizeEdge> {
    match u32::try_from(edge).ok()? {
        WMSZ_LEFT => Some(ResizeEdge::Left),
        WMSZ_RIGHT => Some(ResizeEdge::Right),
        WMSZ_TOP => Some(ResizeEdge::Top),
        WMSZ_BOTTOM => Some(ResizeEdge::Bottom),
        WMSZ_TOPLEFT => Some(ResizeEdge::TopLeft),
        WMSZ_TOPRIGHT => Some(ResizeEdge::TopRight),
        WMSZ_BOTTOMLEFT => Some(ResizeEdge::BottomLeft),
        WMSZ_BOTTOMRIGHT => Some(ResizeEdge::BottomRight),
        _ => None,
    }
}

fn resize_rect(hwnd: HWND, drag: &mut Drag, edge: ResizeEdge, proposed: &mut RECT) -> bool {
    let Some(resize) = drag.resize.as_mut() else {
        return false;
    };
    if resize.neighbors.is_empty() {
        return false;
    }
    let (Some(cursor), Some(outer), Some(client)) =
        (cursor_position(), outer_rect(hwnd), client_rect(hwnd))
    else {
        return false;
    };
    let scale = scale(hwnd);
    let minimum = (
        (crate::desk::MIN_WIDTH * scale).round() as i32,
        (crate::desk::MIN_HEIGHT * scale).round() as i32,
    );
    let insets = (
        client.left - outer.left,
        client.top - outer.top,
        outer.right - client.right,
        outer.bottom - client.bottom,
    );
    let mut desired = Rect {
        left: proposed.left + insets.0,
        top: proposed.top + insets.1,
        right: proposed.right - insets.2,
        bottom: proposed.bottom - insets.3,
    };
    // Preserve raw pointer travel through a snap and through the native minimum-size clamp.
    if edge.left() {
        desired.left = (cursor.x - (resize.offsets.0 * scale).round() as i32 + insets.0)
            .min(desired.right.saturating_sub(minimum.0));
    }
    if edge.right() {
        desired.right = (cursor.x + (resize.offsets.2 * scale).round() as i32 - insets.2)
            .max(desired.left.saturating_add(minimum.0));
    }
    if edge.top() {
        desired.top = (cursor.y - (resize.offsets.1 * scale).round() as i32 + insets.1)
            .min(desired.bottom.saturating_sub(minimum.1));
    }
    if edge.bottom() {
        desired.bottom = (cursor.y + (resize.offsets.3 * scale).round() as i32 - insets.3)
            .max(desired.top.saturating_add(minimum.1));
    }
    let notes: Vec<_> = note_targets(hwnd)
        .into_iter()
        .filter(|note| resize.neighbors.contains(&note.hwnd))
        .map(|note| note.rect)
        .collect();
    let snapped = resize.snap.apply(desired, edge, &notes, scale, minimum);
    proposed.left = snapped.left - insets.0;
    proposed.top = snapped.top - insets.1;
    proposed.right = snapped.right + insets.2;
    proposed.bottom = snapped.bottom + insets.3;
    true
}

fn scale(hwnd: HWND) -> f64 {
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 }
}

#[cfg(test)]
thread_local! {
    static TEST_CURSOR: std::cell::Cell<Option<POINT>> = const { std::cell::Cell::new(None) };
}

fn cursor_position() -> Option<POINT> {
    #[cfg(test)]
    if let Some(point) = TEST_CURSOR.with(|cursor| cursor.get()) {
        return Some(point);
    }
    let mut point = POINT::default();
    (unsafe { GetCursorPos(&mut point) } != 0).then_some(point)
}

fn outer_rect(hwnd: HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    (unsafe { GetWindowRect(hwnd, &mut rect) } != 0).then_some(rect)
}

fn client_rect(hwnd: HWND) -> Option<Rect> {
    let mut rect = RECT::default();
    let mut origin = POINT::default();
    if unsafe { GetClientRect(hwnd, &mut rect) } == 0
        || unsafe { ClientToScreen(hwnd, &mut origin) } == 0
    {
        return None;
    }
    Some(Rect {
        left: origin.x,
        top: origin.y,
        right: origin.x + rect.right,
        bottom: origin.y + rect.bottom,
    })
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _dc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> i32 {
    let mut info = MONITORINFO {
        cbSize: size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetMonitorInfoW(monitor, &mut info) } != 0 {
        let rect = info.rcWork;
        unsafe { &mut *(data as *mut Vec<Rect>) }.push(Rect {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
        });
    }
    1
}

struct NoteTargets {
    current: HWND,
    notes: Vec<NoteTarget>,
}

struct NoteTarget {
    hwnd: HWND,
    rect: Rect,
}

fn note_targets(hwnd: HWND) -> Vec<NoteTarget> {
    let mut targets = NoteTargets {
        current: hwnd,
        notes: Vec::new(),
    };
    unsafe {
        EnumThreadWindows(
            GetCurrentThreadId(),
            Some(collect_note),
            &mut targets as *mut NoteTargets as LPARAM,
        );
    }
    targets.notes
}

unsafe extern "system" fn collect_note(hwnd: HWND, data: LPARAM) -> i32 {
    let targets = unsafe { &mut *(data as *mut NoteTargets) };
    if hwnd == targets.current
        || unsafe { IsWindowVisible(hwnd) } == 0
        || unsafe { IsIconic(hwnd) } != 0
        || unsafe { GetPropW(hwnd, STATE_PROPERTY) }.is_null()
    {
        return 1;
    }
    let mut cloaked: u32 = 0;
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut u32 as *mut _,
            size_of::<u32>() as u32,
        );
    }
    if cloaked == 0 {
        if let Some(rect) = client_rect(hwnd) {
            targets.notes.push(NoteTarget { hwnd, rect });
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::{
        Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOSIZE,
            SWP_NOZORDER, SendMessageW, SetWindowPos, ShowWindow, WS_OVERLAPPEDWINDOW, WS_POPUP,
        },
        core::w,
    };

    struct TestWindow(HWND);

    impl TestWindow {
        fn new(left: i32, top: i32, width: i32, height: i32, snapping: bool) -> Self {
            Self::with_style(left, top, width, height, WS_POPUP, snapping)
        }

        fn with_style(
            left: i32,
            top: i32,
            width: i32,
            height: i32,
            style: u32,
            snapping: bool,
        ) -> Self {
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    w!("STATIC"),
                    w!("CozyNotes snapping test"),
                    style,
                    left,
                    top,
                    width,
                    height,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            assert!(!hwnd.is_null());
            let result = Self(hwnd);
            if snapping {
                unsafe { install(hwnd) }.unwrap();
            }
            result
        }

        fn set_desired(&self, left: i32, top: i32) {
            // Synthetic move messages must not depend on the user's live mouse movement.
            TEST_CURSOR.with(|cursor| cursor.set(Some(POINT { x: 0, y: 0 })));
            let cursor = cursor_position().unwrap();
            let data = unsafe { GetPropW(self.0, STATE_PROPERTY) };
            assert!(!data.is_null());
            let state = unsafe { &*data.cast::<RefCell<Drag>>() };
            state.borrow_mut().anchor = Some((
                f64::from(cursor.x - left) / scale(self.0),
                f64::from(cursor.y - top) / scale(self.0),
            ));
        }

        fn moving(&self, desired: Rect) -> Rect {
            self.set_desired(desired.left, desired.top);
            let mut rect = RECT {
                left: desired.left,
                top: desired.top,
                right: desired.right,
                bottom: desired.bottom,
            };
            assert_eq!(
                unsafe { SendMessageW(self.0, WM_MOVING, 0, &mut rect as *mut RECT as LPARAM) },
                1
            );
            Rect {
                left: rect.left,
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
            }
        }

        fn begin_resize(&self) {
            TEST_CURSOR.with(|cursor| cursor.set(Some(POINT { x: 0, y: 0 })));
            unsafe { SendMessageW(self.0, WM_ENTERSIZEMOVE, 0, 0) };
        }

        fn sizing(&self, edge: u32, desired: Rect, cursor: POINT) -> (LRESULT, Rect) {
            TEST_CURSOR.with(|position| position.set(Some(cursor)));
            let mut rect = RECT {
                left: desired.left,
                top: desired.top,
                right: desired.right,
                bottom: desired.bottom,
            };
            let result = unsafe {
                SendMessageW(
                    self.0,
                    WM_SIZING,
                    edge as WPARAM,
                    &mut rect as *mut RECT as LPARAM,
                )
            };
            (
                result,
                Rect {
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                },
            )
        }
    }

    impl Drop for TestWindow {
        fn drop(&mut self) {
            assert_ne!(unsafe { DestroyWindow(self.0) }, 0);
        }
    }

    fn work_areas() -> Vec<Rect> {
        let mut areas = Vec::new();
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(collect_monitor),
                &mut areas as *mut Vec<Rect> as LPARAM,
            );
        }
        areas
    }

    #[test]
    fn native_moving_message_snaps_visible_notes_and_keeps_the_target_still() {
        let area = work_areas()[0];
        let x = area.left + 200;
        let y = area.top + 100;
        let target = TestWindow::new(x, y, 305, 200, true);
        let moving = TestWindow::new(x, y, 305, 52, true);
        unsafe { ShowWindow(target.0, SW_SHOWNOACTIVATE) };
        let desired = Rect {
            left: x + 311,
            top: y + 6,
            right: x + 616,
            bottom: y + 58,
        };
        let expected = Rect {
            left: x + 305,
            top: y,
            right: x + 610,
            bottom: y + 52,
        };
        let before = client_rect(target.0).unwrap();
        assert_eq!(moving.moving(desired), expected);
        assert_eq!(client_rect(target.0).unwrap(), before);
        unsafe { ShowWindow(target.0, SW_HIDE) };
        assert_eq!(moving.moving(desired), desired);
    }

    #[test]
    fn native_moving_message_ignores_other_windows_and_resets_after_drag() {
        let area = work_areas()[0];
        let x = area.left + 200;
        let y = area.top + 100;
        let unrelated = TestWindow::new(x, y, 305, 200, false);
        unsafe { ShowWindow(unrelated.0, SW_SHOWNOACTIVATE) };
        let moving = TestWindow::new(x, y, 305, 52, true);
        let desired = Rect {
            left: x + 311,
            top: y + 6,
            right: x + 616,
            bottom: y + 58,
        };
        assert_eq!(moving.moving(desired), desired);

        let near_edge = Rect {
            left: area.left + 5,
            top: y,
            right: area.left + 310,
            bottom: y + 52,
        };
        let snapped = moving.moving(near_edge);
        assert_eq!(snapped.left, area.left);
        assert_eq!(snapped.right - snapped.left, 305);
        assert_eq!(snapped.bottom - snapped.top, 52);
        let distance = (15.0 * scale(moving.0)).round() as i32;
        let within_release = Rect {
            left: area.left + distance,
            right: area.left + distance + 305,
            ..near_edge
        };
        assert_eq!(moving.moving(within_release).left, area.left);
        unsafe { SendMessageW(moving.0, WM_EXITSIZEMOVE, 0, 0) };
        assert_eq!(moving.moving(within_release), within_release);
    }

    #[test]
    fn repeated_installation_uses_one_state_and_destruction_removes_it() {
        let window = TestWindow::new(0, 0, 305, 52, true);
        let first = unsafe { GetPropW(window.0, STATE_PROPERTY) };
        unsafe { install(window.0) }.unwrap();
        let second = unsafe { GetPropW(window.0, STATE_PROPERTY) };
        assert!(!first.is_null());
        assert_eq!(first, second);
        let hwnd = window.0;
        drop(window);
        assert!(unsafe { GetPropW(hwnd, STATE_PROPERTY) }.is_null());
    }

    #[test]
    fn native_resize_matches_size_on_all_handles_and_all_neighbor_sides() {
        let area = work_areas()[0];
        let target = TestWindow::new(area.left + 200, area.top + 100, 400, 300, true);
        unsafe { ShowWindow(target.0, SW_SHOWNOACTIVATE) };
        let stationary = client_rect(target.0).unwrap();
        for (x, y) in [
            (stationary.right, stationary.top),
            (stationary.left - 394, stationary.top),
            (stationary.left, stationary.top - 294),
            (stationary.left, stationary.bottom),
        ] {
            for native_edge in [
                WMSZ_LEFT,
                WMSZ_RIGHT,
                WMSZ_TOP,
                WMSZ_BOTTOM,
                WMSZ_TOPLEFT,
                WMSZ_TOPRIGHT,
                WMSZ_BOTTOMLEFT,
                WMSZ_BOTTOMRIGHT,
            ] {
                let moving = TestWindow::new(x, y, 394, 294, true);
                moving.begin_resize();
                let edge = sizing_edge(native_edge as WPARAM).unwrap();
                let dx = if edge.left() {
                    -1
                } else {
                    i32::from(edge.right())
                };
                let dy = if edge.top() {
                    -1
                } else {
                    i32::from(edge.bottom())
                };
                let desired = Rect {
                    left: x + if edge.left() { dx } else { 0 },
                    top: y + if edge.top() { dy } else { 0 },
                    right: x + 394 + if edge.right() { dx } else { 0 },
                    bottom: y + 294 + if edge.bottom() { dy } else { 0 },
                };
                let (handled, result) = moving.sizing(native_edge, desired, POINT { x: dx, y: dy });
                assert_eq!(handled, 1);
                assert_eq!(result.left, x - if edge.left() { 6 } else { 0 });
                assert_eq!(result.right, x + 394 + if edge.right() { 6 } else { 0 });
                assert_eq!(result.top, y - if edge.top() { 6 } else { 0 });
                assert_eq!(result.bottom, y + 294 + if edge.bottom() { 6 } else { 0 });
                assert_eq!(client_rect(target.0).unwrap(), stationary);
            }
        }
    }

    #[test]
    fn native_resize_uses_raw_pointer_for_hysteresis_and_observes_target_visibility() {
        let area = work_areas()[0];
        let x = area.left + 200;
        let y = area.top + 100;
        let target = TestWindow::new(x, y, 400, 300, true);
        unsafe { ShowWindow(target.0, SW_SHOWNOACTIVATE) };
        let moving = TestWindow::new(x + 400, y, 394, 300, true);
        moving.begin_resize();
        for (delta, expected_width) in [(1, 400), (28, 400), (29, 423), (21, 415), (16, 400)] {
            let desired = Rect {
                left: x + 400,
                top: y,
                right: x + 794 + delta,
                bottom: y + 300,
            };
            let (handled, result) = moving.sizing(WMSZ_RIGHT, desired, POINT { x: delta, y: 0 });
            assert_eq!(handled, 1);
            assert_eq!(result.right - result.left, expected_width);
        }
        unsafe { ShowWindow(target.0, SW_HIDE) };
        let desired = Rect {
            left: x + 400,
            top: y,
            right: x + 795,
            bottom: y + 300,
        };
        assert_eq!(
            moving.sizing(WMSZ_RIGHT, desired, POINT { x: 1, y: 0 }).1,
            desired
        );
        unsafe { SendMessageW(moving.0, WM_EXITSIZEMOVE, 0, 0) };
        let data = unsafe { GetPropW(moving.0, STATE_PROPERTY) };
        assert!(
            unsafe { &*data.cast::<RefCell<Drag>>() }
                .borrow()
                .resize
                .is_none()
        );
    }

    #[test]
    fn native_resize_excludes_notes_that_were_not_touching_when_it_started() {
        let area = work_areas()[0];
        let x = area.left + 200;
        let y = area.top + 100;
        let target = TestWindow::new(x, y, 400, 300, true);
        unsafe { ShowWindow(target.0, SW_SHOWNOACTIVATE) };
        let moving = TestWindow::new(x + 500, y, 394, 294, true);
        moving.begin_resize();
        let desired = Rect {
            left: x + 500,
            top: y,
            right: x + 895,
            bottom: y + 294,
        };
        assert_eq!(
            moving.sizing(WMSZ_RIGHT, desired, POINT { x: 1, y: 0 }).1,
            desired
        );
    }

    #[test]
    fn native_resize_matches_visible_dimensions_with_nonzero_frame_insets() {
        let area = work_areas()[0];
        let x = area.left + 200;
        let y = area.top + 100;
        let target = TestWindow::with_style(x, y, 400, 300, WS_OVERLAPPEDWINDOW, true);
        unsafe { ShowWindow(target.0, SW_SHOWNOACTIVATE) };
        let target_rect = client_rect(target.0).unwrap();
        let moving = TestWindow::with_style(x, y, 394, 294, WS_OVERLAPPEDWINDOW, true);
        let outer = outer_rect(moving.0).unwrap();
        let client = client_rect(moving.0).unwrap();
        let inset = (client.left - outer.left, client.top - outer.top);
        assert!(inset.0 != 0 || inset.1 != 0);
        assert_ne!(
            unsafe {
                SetWindowPos(
                    moving.0,
                    std::ptr::null_mut(),
                    target_rect.right - inset.0,
                    target_rect.top - inset.1,
                    0,
                    0,
                    SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER,
                )
            },
            0
        );
        let outer = outer_rect(moving.0).unwrap();
        moving.begin_resize();
        let desired = Rect {
            left: outer.left,
            top: outer.top,
            right: outer.right + 1,
            bottom: outer.bottom + 1,
        };
        let (handled, result) = moving.sizing(WMSZ_BOTTOMRIGHT, desired, POINT { x: 1, y: 1 });
        assert_eq!(handled, 1);
        assert_eq!(
            result,
            Rect {
                left: outer.left,
                top: outer.top,
                right: outer.right + 6,
                bottom: outer.bottom + 6
            }
        );
        assert_eq!(client_rect(target.0).unwrap(), target_rect);
    }
}
