use serde_json::{Map, Value};

// Keep these limits in sync with src/ink.ts. Bounds apply across the whole note,
// including ink nested in lists or blockquotes.
pub const MAX_INK_DRAWINGS: usize = 64;
pub const MAX_DOCUMENT_INK_POINTS: usize = 100_000;
const MAX_INK_STROKES: usize = 512;
const MAX_STROKE_POINTS: usize = 8192;
const MAX_DRAWING_POINTS: usize = 50_000;

fn object_with_keys<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Map<String, Value>> {
    value.as_object().filter(|object| {
        object.len() == names.len() && names.iter().all(|key| object.contains_key(*key))
    })
}

fn in_range(value: &Value, minimum: f64, maximum: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && (minimum..=maximum).contains(&number))
}

pub fn validate(value: &Value) -> Result<usize, String> {
    let invalid = || "The saved document contains unsupported or invalid ink.".to_string();
    let attrs = object_with_keys(
        value,
        &["version", "width", "height", "description", "strokes"],
    )
    .ok_or_else(invalid)?;
    if attrs["version"].as_u64() != Some(1)
        || !in_range(&attrs["width"], 64.0, 4096.0)
        || !in_range(&attrs["height"], 64.0, 4096.0)
        || !attrs["description"]
            .as_str()
            .is_some_and(|text| text.chars().count() <= 240)
    {
        return Err(invalid());
    }
    let strokes = attrs["strokes"].as_array().ok_or_else(invalid)?;
    if strokes.len() > MAX_INK_STROKES {
        return Err(invalid());
    }
    let mut total = 0;
    for stroke in strokes {
        let stroke = object_with_keys(stroke, &["color", "width", "points"]).ok_or_else(invalid)?;
        let color = stroke["color"].as_str().ok_or_else(invalid)?;
        if color.len() != 7
            || !color.starts_with('#')
            || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
            || !in_range(&stroke["width"], 0.5, 24.0)
        {
            return Err(invalid());
        }
        let points = stroke["points"].as_array().ok_or_else(invalid)?;
        if points.is_empty() || points.len() > MAX_STROKE_POINTS {
            return Err(invalid());
        }
        total += points.len();
        if total > MAX_DRAWING_POINTS {
            return Err(invalid());
        }
        for point in points {
            let point = object_with_keys(point, &["x", "y", "pressure", "tiltX", "tiltY"])
                .ok_or_else(invalid)?;
            if !["x", "y", "pressure"]
                .iter()
                .all(|key| in_range(&point[*key], 0.0, 1.0))
                || !["tiltX", "tiltY"]
                    .iter()
                    .all(|key| in_range(&point[*key], -90.0, 90.0))
            {
                return Err(invalid());
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn drawing() -> Value {
        json!({"version":1,"width":600,"height":400,"description":"A flower","strokes":[
            {"color":"#315e9e","width":4,"points":[{"x":0.25,"y":0.5,"pressure":0.7,"tiltX":-30,"tiltY":45}]}
        ]})
    }

    #[test]
    fn accepts_empty_drawings_and_pressure_tilt_and_dots() {
        assert_eq!(validate(&drawing()).unwrap(), 1);
        let mut empty = drawing();
        empty["strokes"] = json!([]);
        assert_eq!(validate(&empty).unwrap(), 0);
    }

    #[test]
    fn rejects_unknown_fields_versions_and_invalid_geometry() {
        for (pointer, value) in [
            ("/version", json!(2)),
            ("/width", json!(0)),
            ("/height", json!(4097)),
            ("/description", json!("x".repeat(241))),
            ("/strokes/0/color", json!("url(evil)")),
            ("/strokes/0/width", json!(-1)),
            ("/strokes/0/points", json!([])),
            ("/strokes/0/points/0/x", json!(1.01)),
            ("/strokes/0/points/0/y", json!(-0.1)),
            ("/strokes/0/points/0/pressure", json!("0.5")),
            ("/strokes/0/points/0/tiltX", json!(91)),
        ] {
            let mut invalid = drawing();
            *invalid.pointer_mut(pointer).unwrap() = value;
            assert!(validate(&invalid).is_err(), "{pointer}");
        }
        for pointer in ["", "/strokes/0", "/strokes/0/points/0"] {
            let mut invalid = drawing();
            invalid.pointer_mut(pointer).unwrap()["unexpected"] = json!(true);
            assert!(validate(&invalid).is_err());
        }
        let mut missing = drawing();
        missing.as_object_mut().unwrap().remove("strokes");
        assert!(validate(&missing).is_err());
    }

    #[test]
    fn enforces_stroke_and_drawing_budgets() {
        let source = drawing();
        let mut invalid = source.clone();
        invalid["strokes"] = json!(vec![source["strokes"][0].clone(); MAX_INK_STROKES + 1]);
        assert!(validate(&invalid).is_err());
        invalid = source.clone();
        invalid["strokes"][0]["points"] = json!(vec![
            source["strokes"][0]["points"][0].clone();
            MAX_STROKE_POINTS + 1
        ]);
        assert!(validate(&invalid).is_err());
        let mut full_stroke = source["strokes"][0].clone();
        full_stroke["points"] = json!(vec![
            source["strokes"][0]["points"][0].clone();
            MAX_STROKE_POINTS
        ]);
        invalid["strokes"] = json!(vec![full_stroke; 7]);
        assert!(validate(&invalid).is_err());
    }
}
