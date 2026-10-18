#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Default, Debug)]
pub(super) struct SnapState {
    x: Option<Target>,
    y: Option<Target>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Kind {
    WorkStart,
    WorkEnd,
    AdjacentStart,
    AdjacentEnd,
    AlignedStart,
    AlignedEnd,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Target {
    position: i64,
    source: Rect,
    kind: Kind,
}

#[derive(Clone, Copy)]
enum Axis {
    X,
    Y,
}

impl Axis {
    fn span(self, rect: Rect) -> (i64, i64) {
        match self {
            Self::X => (i64::from(rect.left), i64::from(rect.right)),
            Self::Y => (i64::from(rect.top), i64::from(rect.bottom)),
        }
    }

    fn other(self) -> Self {
        match self {
            Self::X => Self::Y,
            Self::Y => Self::X,
        }
    }
}

impl Rect {
    fn valid(self) -> bool {
        self.left < self.right && self.top < self.bottom
    }

    fn intersects(self, other: Self) -> bool {
        overlaps(Axis::X.span(self), Axis::X.span(other))
            && overlaps(Axis::Y.span(self), Axis::Y.span(other))
    }

    fn translated_to(self, x: i64, y: i64) -> Option<Self> {
        let width = i64::from(self.right) - i64::from(self.left);
        let height = i64::from(self.bottom) - i64::from(self.top);
        Some(Self {
            left: x.try_into().ok()?,
            top: y.try_into().ok()?,
            right: (x + width).try_into().ok()?,
            bottom: (y + height).try_into().ok()?,
        })
    }
}

fn overlaps(a: (i64, i64), b: (i64, i64)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

impl Target {
    fn valid_at(self, rect: Rect, axis: Axis) -> bool {
        let along = axis.span(rect);
        let source_along = axis.span(self.source);
        let across = axis.other().span(rect);
        let source_across = axis.other().span(self.source);
        match self.kind {
            Kind::WorkStart | Kind::WorkEnd => true,
            Kind::AdjacentStart | Kind::AdjacentEnd => overlaps(across, source_across),
            Kind::AlignedStart | Kind::AlignedEnd => {
                overlaps(along, source_along)
                    && (across.0 == source_across.1 || across.1 == source_across.0)
            }
        }
    }

    fn key(self) -> (i64, Kind, i32, i32, i32, i32) {
        (
            self.position,
            self.kind,
            self.source.left,
            self.source.top,
            self.source.right,
            self.source.bottom,
        )
    }
}

fn candidates(
    desired: Rect,
    areas: &[Rect],
    notes: &[Rect],
    axis: Axis,
    held: Option<Target>,
    capture: f64,
    release: f64,
) -> Vec<Option<Target>> {
    let (start, end) = axis.span(desired);
    let size = end - start;
    let mut result = vec![None];
    let mut add = |source, kind, position: i64| {
        let target = Target {
            position,
            source,
            kind,
        };
        let limit = if held == Some(target) {
            release
        } else {
            capture
        };
        if (position - start).abs() as f64 <= limit {
            result.push(Some(target));
        }
    };

    // Use raw pointer geometry for monitor eligibility, including while latched.
    for &area in areas {
        if area.valid() && desired.intersects(area) {
            let (low, high) = axis.span(area);
            add(area, Kind::WorkStart, low);
            add(area, Kind::WorkEnd, high - size);
        }
    }
    for &note in notes {
        if note.valid() {
            let (low, high) = axis.span(note);
            add(note, Kind::AdjacentStart, high);
            add(note, Kind::AdjacentEnd, low - size);
            add(note, Kind::AlignedStart, low);
            add(note, Kind::AlignedEnd, high - size);
        }
    }
    result
}

impl SnapState {
    /// Snap physical rectangles using logical capture/release distances.
    /// `desired` must come from the original pointer anchor on every call.
    /// Start a new state for each drag; other notes must exclude the dragged note.
    pub fn apply(&mut self, desired: Rect, areas: &[Rect], notes: &[Rect], scale: f64) -> Rect {
        if !desired.valid() {
            *self = Self::default();
            return desired;
        }
        let scale = if scale.is_finite() && scale > 0.0 {
            scale
        } else {
            1.0
        };
        let xs = candidates(
            desired,
            areas,
            notes,
            Axis::X,
            self.x,
            10.0 * scale,
            22.0 * scale,
        );
        let ys = candidates(
            desired,
            areas,
            notes,
            Axis::Y,
            self.y,
            10.0 * scale,
            22.0 * scale,
        );
        let mut best = None;

        // Evaluate axes together: a secondary alignment is eligible only when the
        // resulting rectangle is actually adjacent. Positive shared spans reject
        // diagonal point-to-point capture, even when both gaps are small.
        for &x in &xs {
            for &y in &ys {
                let left = x.map_or(i64::from(desired.left), |t| t.position);
                let top = y.map_or(i64::from(desired.top), |t| t.position);
                let Some(rect) = desired.translated_to(left, top) else {
                    continue;
                };
                if x.is_some_and(|t| !t.valid_at(rect, Axis::X))
                    || y.is_some_and(|t| !t.valid_at(rect, Axis::Y))
                {
                    continue;
                }
                let retained = usize::from(x.is_some() && x == self.x)
                    + usize::from(y.is_some() && y == self.y);
                let count = usize::from(x.is_some()) + usize::from(y.is_some());
                let dx = (left - i64::from(desired.left)).abs();
                let dy = (top - i64::from(desired.top)).abs();
                // Preserve compatible latches, then capture both axes if possible.
                // Among those choices prefer least total movement, then X distance,
                // then numeric geometry. Input ordering never breaks a tie.
                let score = (
                    2 - retained,
                    2 - count,
                    dx + dy,
                    dx,
                    dy,
                    x.map(Target::key),
                    y.map(Target::key),
                );
                if best.as_ref().is_none_or(|(old, _, _, _)| score < *old) {
                    best = Some((score, rect, x, y));
                }
            }
        }
        let (_, result, x, y) = best.expect("the unchanged valid rectangle is always a candidate");
        self.x = x;
        self.y = y;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(left: i32, top: i32, width: i32, height: i32) -> Rect {
        Rect {
            left,
            top,
            right: left + width,
            bottom: top + height,
        }
    }

    fn snap(desired: Rect, areas: &[Rect], notes: &[Rect], scale: f64) -> Rect {
        SnapState::default().apply(desired, areas, notes, scale)
    }

    #[test]
    fn every_work_area_edge_and_corner_is_flush() {
        let area = r(0, 0, 1000, 800);
        for (x, y, expected_x, expected_y) in [
            (7, 300, 0, 300),
            (893, 300, 900, 300),
            (400, 8, 400, 0),
            (400, 692, 400, 700),
            (7, 8, 0, 0),
            (893, 8, 900, 0),
            (7, 692, 0, 700),
            (893, 692, 900, 700),
        ] {
            assert_eq!(
                snap(r(x, y, 100, 100), &[area], &[], 1.0),
                r(expected_x, expected_y, 100, 100)
            );
        }
    }

    #[test]
    fn every_adjacent_note_side_is_flush() {
        let note = r(300, 300, 200, 200);
        for (desired, expected) in [
            (r(207, 350, 100, 100), r(200, 350, 100, 100)),
            (r(493, 350, 100, 100), r(500, 350, 100, 100)),
            (r(350, 207, 100, 100), r(350, 200, 100, 100)),
            (r(350, 493, 100, 100), r(350, 500, 100, 100)),
        ] {
            assert_eq!(snap(desired, &[], &[note], 1.0), expected);
        }
    }

    #[test]
    fn adjacent_notes_align_both_ends_of_rows_and_columns() {
        let note = r(300, 300, 200, 200);
        for (x, y, expected_x, expected_y) in [
            (207, 307, 200, 300),
            (207, 393, 200, 400),
            (493, 307, 500, 300),
            (493, 393, 500, 400),
            (307, 207, 300, 200),
            (393, 207, 400, 200),
            (307, 493, 300, 500),
            (393, 493, 400, 500),
        ] {
            assert_eq!(
                snap(r(x, y, 100, 100), &[], &[note], 1.0),
                r(expected_x, expected_y, 100, 100)
            );
        }
    }

    #[test]
    fn distant_spans_and_unrelated_same_side_alignments_are_ignored() {
        let note = r(300, 300, 200, 200);
        for desired in [
            r(207, 900, 100, 100),
            r(900, 207, 100, 100),
            r(307, 900, 100, 100),
            r(900, 307, 100, 100),
            r(307, 350, 100, 100),
        ] {
            assert_eq!(snap(desired, &[], &[note], 1.0), desired);
        }
    }

    #[test]
    fn diagonal_near_misses_and_exact_point_contacts_do_not_capture() {
        let note = r(300, 300, 200, 200);
        for desired in [
            r(502, 502, 100, 100),
            r(198, 198, 100, 100),
            r(500, 500, 100, 100),
            r(502, 500, 100, 100),
        ] {
            assert_eq!(snap(desired, &[], &[note], 1.0), desired);
        }
    }

    #[test]
    fn tiny_notes_can_close_a_gap_to_form_an_aligned_corner() {
        let note = r(100, 100, 50, 4);
        assert_eq!(
            snap(r(156, 107, 50, 4), &[], &[note], 1.0),
            r(150, 100, 50, 4)
        );
        let note = r(100, 100, 4, 50);
        assert_eq!(
            snap(r(107, 156, 4, 50), &[], &[note], 1.0),
            r(100, 150, 4, 50)
        );
    }

    #[test]
    fn folded_notes_preserve_size_and_can_form_rows() {
        let note = r(400, 200, 305, 52);
        assert_eq!(
            snap(r(712, 206, 305, 52), &[], &[note], 1.0),
            r(705, 200, 305, 52)
        );
    }

    #[test]
    fn nearest_target_wins_and_ties_ignore_input_order() {
        let desired = r(100, 150, 100, 50);
        let near = r(202, 100, 100, 200);
        let far = r(5, 100, 100, 200);
        assert_eq!(snap(desired, &[], &[far, near], 1.0).left, 102);
        let tied = r(-2, 100, 100, 200);
        let expected = r(98, 150, 100, 50);
        assert_eq!(snap(desired, &[], &[near, tied], 1.0), expected);
        assert_eq!(snap(desired, &[], &[tied, near], 1.0), expected);

        let areas = [r(95, 0, 1000, 1000), r(105, 0, 1000, 1000)];
        assert_eq!(snap(desired, &areas, &[], 1.0).left, 95);
        assert_eq!(snap(desired, &[areas[1], areas[0]], &[], 1.0).left, 95);
    }

    #[test]
    fn latches_hold_to_release_then_break_away_using_raw_pointer_position() {
        let area = r(0, 0, 1000, 800);
        let mut state = SnapState::default();
        assert_eq!(
            state.apply(r(10, 10, 100, 100), &[area], &[], 1.0),
            r(0, 0, 100, 100)
        );
        assert_eq!(
            state.apply(r(22, 22, 100, 100), &[area], &[], 1.0),
            r(0, 0, 100, 100)
        );
        assert_eq!(
            state.apply(r(23, 22, 100, 100), &[area], &[], 1.0),
            r(23, 0, 100, 100)
        );
        assert_eq!(
            state.apply(r(15, 23, 100, 100), &[area], &[], 1.0),
            r(15, 23, 100, 100)
        );
        assert_eq!(
            state.apply(r(10, 15, 100, 100), &[area], &[], 1.0),
            r(0, 15, 100, 100)
        );
    }

    #[test]
    fn existing_latch_beats_a_new_closer_target() {
        let first = r(200, 100, 100, 200);
        let second = r(220, 100, 100, 200);
        let mut state = SnapState::default();
        assert_eq!(
            state
                .apply(r(95, 150, 100, 50), &[], &[first, second], 1.0)
                .left,
            100
        );
        assert_eq!(
            state
                .apply(r(119, 150, 100, 50), &[], &[second, first], 1.0)
                .left,
            100
        );
        assert_eq!(
            state
                .apply(r(123, 150, 100, 50), &[], &[first, second], 1.0)
                .left,
            120
        );
    }

    #[test]
    fn note_corner_holds_both_axes_and_secondary_releases_with_adjacency() {
        let note = r(300, 300, 200, 200);
        let mut state = SnapState::default();
        assert_eq!(
            state.apply(r(507, 307, 100, 52), &[], &[note], 1.0),
            r(500, 300, 100, 52)
        );
        assert_eq!(
            state.apply(r(522, 322, 100, 52), &[], &[note], 1.0),
            r(500, 300, 100, 52)
        );
        let released = r(523, 322, 100, 52);
        assert_eq!(state.apply(released, &[], &[note], 1.0), released);
        let outside_capture = r(515, 315, 100, 52);
        assert_eq!(
            state.apply(outside_capture, &[], &[note], 1.0),
            outside_capture
        );
    }

    #[test]
    fn pull_away_works_in_both_directions_on_both_axes() {
        let area = r(-1000, -1000, 2000, 2000);
        for (axis, origin) in [
            (Axis::X, -1000),
            (Axis::X, 900),
            (Axis::Y, -1000),
            (Axis::Y, 900),
        ] {
            for direction in [-1, 1] {
                let desired = |distance| match axis {
                    Axis::X => r(origin + direction * distance, 100, 100, 100),
                    Axis::Y => r(100, origin + direction * distance, 100, 100),
                };
                let mut state = SnapState::default();
                assert_eq!(state.apply(desired(7), &[area], &[], 1.0), desired(0));
                assert_eq!(state.apply(desired(22), &[area], &[], 1.0), desired(0));
                assert_eq!(state.apply(desired(23), &[area], &[], 1.0), desired(23));
            }
        }
    }

    #[test]
    fn secondary_alignment_requires_adjacency_in_the_selected_result() {
        let row = r(300, 300, 200, 200);
        let closer = r(602, 250, 200, 200);
        let desired = r(508, 307, 100, 52);
        // The row permits a corner at (500, 300). Its Y alignment cannot be
        // combined with the closer note's X alignment at 502: that leaves a gap.
        assert_eq!(
            snap(desired, &[], &[row, closer], 1.0),
            r(500, 300, 100, 52)
        );
        assert_eq!(
            snap(desired, &[], &[closer, row], 1.0),
            r(500, 300, 100, 52)
        );
        let separated = r(511, 307, 100, 52);
        assert_eq!(snap(separated, &[], &[row], 1.0), separated);
    }

    #[test]
    fn huge_finite_scale_preserves_dimensions_even_when_only_one_axis_can_snap() {
        let desired = Rect {
            left: i32::MIN + 4,
            top: -50,
            right: i32::MAX,
            bottom: 2,
        };
        let result = snap(desired, &[r(0, -100, 1000, 200)], &[], f64::MAX);
        assert_eq!((result.left, result.right), (desired.left, desired.right));
        assert_eq!(i64::from(result.bottom) - i64::from(result.top), 52);
        assert_eq!(result.top, -100);
    }

    #[test]
    fn dimensions_and_translation_bounds_hold_across_a_drag_grid() {
        let areas = [r(-1000, -800, 1000, 800), r(0, -800, 1000, 800)];
        let notes = [r(-350, -400, 305, 52), r(300, -400, 200, 200)];
        for scale in [0.5, 1.0, 1.25, 2.0] {
            let mut state = SnapState::default();
            for left in (-1050..1050).step_by(37) {
                for top in (-850..50).step_by(29) {
                    let desired = r(left, top, 305, 52);
                    let result = state.apply(desired, &areas, &notes, scale);
                    assert_eq!(result.right - result.left, 305);
                    assert_eq!(result.bottom - result.top, 52);
                    assert!(f64::from((result.left - left).abs()) <= 22.0 * scale);
                    assert!(f64::from((result.top - top).abs()) <= 22.0 * scale);
                }
            }
        }
    }

    #[test]
    fn capture_is_inclusive_and_hysteresis_is_scale_normalized() {
        let area = r(-1000, -1000, 3000, 3000);
        for (scale, capture, release) in [
            (0.5, 5, 11),
            (1.0, 10, 22),
            (1.25, 12, 27),
            (1.5, 15, 33),
            (2.0, 20, 44),
        ] {
            let mut state = SnapState::default();
            let at = |distance| r(-1000 + distance, 100, 100, 52);
            assert_eq!(snap(at(capture + 1), &[area], &[], scale), at(capture + 1));
            assert_eq!(state.apply(at(capture), &[area], &[], scale).left, -1000);
            assert_eq!(state.apply(at(release), &[area], &[], scale).left, -1000);
            assert_eq!(
                state.apply(at(release + 1), &[area], &[], scale),
                at(release + 1)
            );
        }
    }

    #[test]
    fn changing_scale_updates_an_existing_latch() {
        let area = r(0, 0, 1000, 800);
        let mut state = SnapState::default();
        assert_eq!(state.apply(r(18, 200, 100, 52), &[area], &[], 2.0).left, 0);
        assert_eq!(state.apply(r(40, 200, 100, 52), &[area], &[], 2.0).left, 0);
        assert_eq!(state.apply(r(40, 200, 100, 52), &[area], &[], 1.0).left, 40);
    }

    #[test]
    fn invalid_scales_fall_back_to_one() {
        let area = r(0, 0, 1000, 800);
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(snap(r(10, 200, 100, 52), &[area], &[], scale).left, 0);
            assert_eq!(snap(r(11, 200, 100, 52), &[area], &[], scale).left, 11);
        }
    }

    #[test]
    fn negative_monitor_origins_and_nonintersecting_monitors() {
        let area = r(-1920, -1080, 1920, 1080);
        assert_eq!(
            snap(r(-1914, -1073, 100, 52), &[area], &[], 1.0),
            r(-1920, -1080, 100, 52)
        );
        let remote = r(0, 1000, 1000, 800);
        let desired = r(6, 100, 100, 52);
        assert_eq!(snap(desired, &[remote], &[], 1.0), desired);
        let outside = r(-100, 100, 100, 52);
        assert_eq!(snap(outside, &[r(0, 0, 1000, 800)], &[], 1.0), outside);
    }

    #[test]
    fn crossing_a_monitor_seam_and_pulling_away_is_possible() {
        let areas = [r(-1000, 0, 1000, 800), r(0, 0, 1000, 800)];
        let mut state = SnapState::default();
        assert_eq!(
            state.apply(r(-106, 200, 100, 52), &areas, &[], 1.0).left,
            -100
        );
        assert_eq!(
            state.apply(r(-78, 200, 100, 52), &areas, &[], 1.0).left,
            -100
        );
        assert_eq!(
            state.apply(r(-77, 200, 100, 52), &areas, &[], 1.0).left,
            -77
        );
        assert_eq!(state.apply(r(6, 200, 100, 52), &areas, &[], 1.0).left, 0);
        assert_eq!(state.apply(r(23, 200, 100, 52), &areas, &[], 1.0).left, 23);
    }

    #[test]
    fn disappearing_targets_and_lost_adjacency_clear_latches() {
        let note = r(300, 300, 200, 200);
        let mut state = SnapState::default();
        state.apply(r(493, 350, 100, 52), &[], &[note], 1.0);
        let desired = r(485, 800, 100, 52);
        assert_eq!(state.apply(desired, &[], &[note], 1.0), desired);
        state.apply(r(493, 350, 100, 52), &[], &[note], 1.0);
        let desired = r(485, 350, 100, 52);
        assert_eq!(state.apply(desired, &[], &[], 1.0), desired);
    }

    #[test]
    fn separate_drags_have_independent_hysteresis() {
        let area = r(0, 0, 1000, 800);
        let mut first = SnapState::default();
        let mut second = SnapState::default();
        first.apply(r(7, 200, 100, 52), &[area], &[], 1.0);
        let desired = r(18, 200, 100, 52);
        assert_eq!(first.apply(desired, &[area], &[], 1.0).left, 0);
        assert_eq!(second.apply(desired, &[area], &[], 1.0), desired);
    }

    #[test]
    fn translation_preserves_dimensions_near_integer_limits() {
        for (area, desired, expected) in [
            (
                r(i32::MIN, -100, 1000, 200),
                r(i32::MIN + 7, -50, 305, 52),
                r(i32::MIN, -50, 305, 52),
            ),
            (
                r(i32::MAX - 1000, -100, 1000, 200),
                r(i32::MAX - 312, -50, 305, 52),
                r(i32::MAX - 305, -50, 305, 52),
            ),
        ] {
            let result = snap(desired, &[area], &[], 1.0);
            assert_eq!(result, expected);
            assert_eq!(i64::from(result.right) - i64::from(result.left), 305);
            assert_eq!(i64::from(result.bottom) - i64::from(result.top), 52);
        }
        let desired = Rect {
            left: i32::MIN + 4,
            top: -50,
            right: i32::MAX,
            bottom: 2,
        };
        let overflowing = r(i32::MIN + 10, -100, 1000, 200);
        assert_eq!(snap(desired, &[overflowing], &[], 1.0), desired);
    }

    #[test]
    fn empty_inputs_and_invalid_rectangles_leave_the_request_unchanged() {
        let desired = r(123, -456, 305, 52);
        assert_eq!(snap(desired, &[], &[], 1.0), desired);
        let invalid = r(123, -456, 0, 52);
        assert_eq!(snap(desired, &[invalid], &[invalid], 1.0), desired);
        let mut state = SnapState::default();
        state.apply(r(3, 100, 100, 52), &[r(0, 0, 1000, 800)], &[], 1.0);
        assert_eq!(state.apply(invalid, &[], &[], 1.0), invalid);
        assert!(state.x.is_none() && state.y.is_none());
    }
}
