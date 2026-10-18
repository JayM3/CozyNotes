use super::geometry::Rect;

#[derive(Clone, Copy, Debug)]
pub(super) enum ResizeEdge {
    Left,
    Right,
    Top,
    Bottom,
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl ResizeEdge {
    pub fn left(self) -> bool {
        matches!(self, Self::Left | Self::TopLeft | Self::BottomLeft)
    }

    pub fn right(self) -> bool {
        matches!(self, Self::Right | Self::TopRight | Self::BottomRight)
    }

    pub fn top(self) -> bool {
        matches!(self, Self::Top | Self::TopLeft | Self::TopRight)
    }

    pub fn bottom(self) -> bool {
        matches!(self, Self::Bottom | Self::BottomLeft | Self::BottomRight)
    }
}

#[derive(Default)]
pub(super) struct ResizeSnapState {
    width: Option<i64>,
    height: Option<i64>,
}

fn valid(rect: Rect) -> bool {
    rect.left < rect.right && rect.top < rect.bottom
}

fn display_scale(scale: f64) -> f64 {
    if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    }
}

fn thresholds(scale: f64) -> (f64, f64) {
    let scale = display_scale(scale);
    (10.0 * scale, 22.0 * scale)
}

pub(super) fn adjacent(a: Rect, b: Rect, scale: f64) -> bool {
    if !valid(a) || !valid(b) {
        return false;
    }
    let tolerance = 2.0 * display_scale(scale);
    let near = |a: i32, b: i32| (i64::from(a) - i64::from(b)).abs() as f64 <= tolerance;
    ((near(a.left, b.right) || near(a.right, b.left)) && a.top < b.bottom && b.top < a.bottom)
        || ((near(a.top, b.bottom) || near(a.bottom, b.top))
            && a.left < b.right
            && b.left < a.right)
}

fn dimension(
    desired: i64,
    held: Option<i64>,
    targets: impl Iterator<Item = i64>,
    minimum: i32,
    scale: f64,
) -> Option<i64> {
    let (capture, release) = thresholds(scale);
    targets
        .filter(|&size| size >= i64::from(minimum.max(1)))
        .filter(|&size| {
            (size - desired).abs() as f64 <= if Some(size) == held { release } else { capture }
        })
        .min_by_key(|&size| (Some(size) != held, (size - desired).abs(), size))
}

impl ResizeSnapState {
    // Raw desired bounds must use the original pointer offsets, not the last snapped size.
    pub fn apply(
        &mut self,
        desired: Rect,
        edge: ResizeEdge,
        notes: &[Rect],
        scale: f64,
        minimum: (i32, i32),
    ) -> Rect {
        if !valid(desired) {
            *self = Self::default();
            return desired;
        }
        let mut result = desired;
        if edge.left() || edge.right() {
            self.width = dimension(
                i64::from(desired.right) - i64::from(desired.left),
                self.width,
                notes
                    .iter()
                    .copied()
                    .filter(|&r| valid(r))
                    .map(|r| i64::from(r.right) - i64::from(r.left)),
                minimum.0,
                scale,
            );
            if let Some(width) = self.width {
                let position = if edge.left() {
                    i64::from(desired.right) - width
                } else {
                    i64::from(desired.left) + width
                };
                if let Ok(position) = i32::try_from(position) {
                    if edge.left() {
                        result.left = position;
                    } else {
                        result.right = position;
                    }
                } else {
                    self.width = None;
                }
            }
        } else {
            self.width = None;
        }
        if edge.top() || edge.bottom() {
            self.height = dimension(
                i64::from(desired.bottom) - i64::from(desired.top),
                self.height,
                notes
                    .iter()
                    .copied()
                    .filter(|&r| valid(r))
                    .map(|r| i64::from(r.bottom) - i64::from(r.top)),
                minimum.1,
                scale,
            );
            if let Some(height) = self.height {
                let position = if edge.top() {
                    i64::from(desired.bottom) - height
                } else {
                    i64::from(desired.top) + height
                };
                if let Ok(position) = i32::try_from(position) {
                    if edge.top() {
                        result.top = position;
                    } else {
                        result.bottom = position;
                    }
                } else {
                    self.height = None;
                }
            }
        } else {
            self.height = None;
        }
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

    #[test]
    fn all_four_edges_and_corners_match_dimensions_with_opposite_edges_fixed() {
        let note = r(900, 500, 400, 300);
        let desired = r(100, 100, 394, 294);
        for edge in [
            ResizeEdge::Left,
            ResizeEdge::Right,
            ResizeEdge::Top,
            ResizeEdge::Bottom,
            ResizeEdge::TopLeft,
            ResizeEdge::TopRight,
            ResizeEdge::BottomLeft,
            ResizeEdge::BottomRight,
        ] {
            let result = ResizeSnapState::default().apply(desired, edge, &[note], 1.0, (305, 240));
            assert_eq!(result.left, if edge.left() { 94 } else { 100 });
            assert_eq!(result.right, if edge.right() { 500 } else { 494 });
            assert_eq!(result.top, if edge.top() { 94 } else { 100 });
            assert_eq!(result.bottom, if edge.bottom() { 400 } else { 394 });
        }
    }

    #[test]
    fn adjacency_accepts_every_side_but_rejects_distant_and_diagonal_notes() {
        let note = r(0, 0, 400, 300);
        for other in [
            r(-400, 0, 400, 300),
            r(400, 0, 400, 300),
            r(0, -300, 400, 300),
            r(0, 300, 400, 300),
            r(402, 0, 400, 300),
        ] {
            assert!(adjacent(note, other, 1.0));
        }
        for other in [
            r(403, 0, 400, 300),
            r(0, 1000, 400, 300),
            r(400, 300, 400, 300),
            note,
        ] {
            assert!(!adjacent(note, other, 1.0));
        }
        assert!(adjacent(note, r(404, 0, 400, 300), 2.0));
    }

    #[test]
    fn matching_is_dimension_based_even_with_offset_neighbors() {
        let desired = r(-700, -100, 394, 294);
        let result = ResizeSnapState::default().apply(
            desired,
            ResizeEdge::BottomRight,
            &[r(-306, -250, 400, 300)],
            1.0,
            (305, 240),
        );
        assert_eq!(result, r(-700, -100, 400, 300));
    }

    #[test]
    fn capture_holds_and_releases_without_recapturing_until_back_in_range() {
        let note = r(900, 500, 400, 300);
        for edge in [
            ResizeEdge::Left,
            ResizeEdge::Right,
            ResizeEdge::Top,
            ResizeEdge::Bottom,
        ] {
            let horizontal = edge.left() || edge.right();
            let target = if horizontal { 400 } else { 300 };
            let mut state = ResizeSnapState::default();
            for (raw, expected) in [
                (target - 10, target),
                (target + 22, target),
                (target + 23, target + 23),
                (target + 15, target + 15),
                (target + 10, target),
            ] {
                let desired = if horizontal {
                    r(100, 100, raw, 300)
                } else {
                    r(100, 100, 400, raw)
                };
                let result = state.apply(desired, edge, &[note], 1.0, (305, 240));
                assert_eq!(
                    if horizontal {
                        result.right - result.left
                    } else {
                        result.bottom - result.top
                    },
                    expected
                );
            }
        }
    }

    #[test]
    fn capture_and_release_follow_display_scaling() {
        let note = r(900, 500, 600, 450);
        let mut state = ResizeSnapState::default();
        for (raw, expected) in [(585, 600), (633, 600), (634, 634)] {
            let result = state.apply(
                r(0, 0, raw, 450),
                ResizeEdge::Right,
                &[note],
                1.5,
                (458, 360),
            );
            assert_eq!(result.right, expected);
        }
    }

    #[test]
    fn undersized_and_folded_targets_cannot_violate_minimums() {
        let desired = r(0, 0, 306, 246);
        let result = ResizeSnapState::default().apply(
            desired,
            ResizeEdge::BottomRight,
            &[r(500, 0, 300, 238), r(900, 0, 305, 52)],
            1.0,
            (305, 240),
        );
        assert_eq!(result, r(0, 0, 305, 246));
    }

    #[test]
    fn nearest_ties_and_latches_ignore_target_enumeration_order() {
        let notes = [r(0, 0, 398, 300), r(500, 0, 402, 300)];
        let desired = r(0, 0, 400, 300);
        for targets in [notes, [notes[1], notes[0]]] {
            let mut state = ResizeSnapState::default();
            assert_eq!(
                state
                    .apply(desired, ResizeEdge::Right, &targets, 1.0, (305, 240))
                    .right,
                398
            );
            assert_eq!(
                state
                    .apply(
                        r(0, 0, 403, 300),
                        ResizeEdge::Right,
                        &targets,
                        1.0,
                        (305, 240)
                    )
                    .right,
                398
            );
        }
    }

    #[test]
    fn disappearing_targets_reset_dimension_latches() {
        let mut state = ResizeSnapState::default();
        let desired = r(0, 0, 394, 294);
        state.apply(
            desired,
            ResizeEdge::BottomRight,
            &[r(500, 0, 400, 300)],
            1.0,
            (305, 240),
        );
        assert_eq!(
            state.apply(desired, ResizeEdge::BottomRight, &[], 1.0, (305, 240)),
            desired
        );
    }

    #[test]
    fn dimension_matching_cannot_overflow_the_anchored_origin() {
        let desired = r(i32::MAX - 394, 0, 394, 300);
        let result = ResizeSnapState::default().apply(
            desired,
            ResizeEdge::Right,
            &[r(0, 0, 400, 300)],
            1.0,
            (305, 240),
        );
        assert_eq!(result, desired);
    }
}
