use caseless::Caseless;
use serde::Serialize;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SnippetPart {
    pub text: String,
    pub matched: bool,
}

pub fn search_key(text: &str) -> String {
    text.nfc().default_case_fold().nfc().collect()
}

pub fn validate(document: &Value) -> Result<(), String> {
    if document.get("type").and_then(Value::as_str) != Some("doc") {
        return Err("The saved document is not a supported note document.".into());
    }
    validate_node(document, 0)
}

fn kind(node: &Value) -> &str {
    node.get("type").and_then(Value::as_str).unwrap_or("")
}

fn is_block(name: &str) -> bool {
    matches!(
        name,
        "paragraph"
            | "heading"
            | "blockquote"
            | "bulletList"
            | "orderedList"
            | "taskList"
            | "codeBlock"
            | "horizontalRule"
            | "image"
    )
}

fn validate_node(node: &Value, depth: usize) -> Result<(), String> {
    let invalid = || "The saved document contains unsupported or invalid content.".to_string();
    if depth > 96 {
        return Err("The saved document is nested too deeply to open safely.".into());
    }
    let object = node.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "type" | "attrs" | "content" | "text" | "marks"
        )
    }) {
        return Err(invalid());
    }
    let name = kind(node);
    let content = match object.get("content") {
        Some(Value::Array(children)) => children.as_slice(),
        Some(_) => return Err(invalid()),
        None => &[],
    };
    let valid_children = match name {
        "doc" | "blockquote" => {
            !content.is_empty() && content.iter().all(|child| is_block(kind(child)))
        }
        "paragraph" | "heading" => content
            .iter()
            .all(|child| matches!(kind(child), "text" | "hardBreak")),
        "codeBlock" => content.iter().all(|child| {
            kind(child) == "text"
                && child
                    .get("marks")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty)
        }),
        "bulletList" | "orderedList" => {
            !content.is_empty() && content.iter().all(|child| kind(child) == "listItem")
        }
        "taskList" => !content.is_empty() && content.iter().all(|child| kind(child) == "taskItem"),
        "listItem" | "taskItem" => {
            content
                .first()
                .is_some_and(|child| kind(child) == "paragraph")
                && content.iter().skip(1).all(|child| is_block(kind(child)))
        }
        "text" | "hardBreak" | "horizontalRule" | "image" => content.is_empty(),
        _ => false,
    };
    if !valid_children || (name == "doc" && depth != 0) {
        return Err(invalid());
    }
    if name == "image"
        && !object
            .get("attrs")
            .and_then(Value::as_object)
            .and_then(|attrs| attrs.get("assetId"))
            .and_then(Value::as_str)
            .is_some_and(crate::assets::is_valid_asset_id)
    {
        return Err(invalid());
    }
    match (name, object.get("text")) {
        ("text", Some(Value::String(text))) if !text.is_empty() => {}
        ("text", _) | (_, Some(_)) => return Err(invalid()),
        _ => {}
    }
    if let Some(attrs) = object.get("attrs") {
        let attrs = attrs.as_object().ok_or_else(invalid)?;
        for (key, value) in attrs {
            let valid = match (name, key.as_str()) {
                ("heading", "level") => {
                    value.as_u64().is_some_and(|level| (1..=6).contains(&level))
                }
                ("orderedList", "start") => value.as_i64().is_some(),
                ("orderedList", "type") | ("codeBlock", "language") => {
                    value.is_null() || value.is_string()
                }
                ("taskItem", "checked") => value.is_boolean(),
                ("image", "assetId") => {
                    value.as_str().is_some_and(crate::assets::is_valid_asset_id)
                }
                ("image", "alt") => value.is_null() || value.is_string(),
                _ => false,
            };
            if !valid {
                return Err(invalid());
            }
        }
    }
    if let Some(marks) = object.get("marks") {
        let marks = marks.as_array().ok_or_else(invalid)?;
        if !marks.is_empty() && !matches!(name, "text" | "hardBreak") {
            return Err(invalid());
        }
        let mut seen = std::collections::HashSet::new();
        for mark in marks {
            let object = mark.as_object().ok_or_else(invalid)?;
            let mark_kind = kind(mark);
            if !matches!(
                mark_kind,
                "bold" | "italic" | "underline" | "strike" | "code" | "link"
            ) || !seen.insert(mark_kind)
                || object
                    .keys()
                    .any(|key| !matches!(key.as_str(), "type" | "attrs"))
            {
                return Err(invalid());
            }
            if let Some(attrs) = object.get("attrs") {
                let attrs = attrs.as_object().ok_or_else(invalid)?;
                if attrs.iter().any(|(key, value)| {
                    mark_kind != "link"
                        || !matches!(key.as_str(), "href" | "target" | "rel" | "class" | "title")
                        || (!value.is_null() && !value.is_string())
                }) {
                    return Err(invalid());
                }
            }
        }
        if seen.contains("code") && seen.len() > 1 {
            return Err(invalid());
        }
    }
    for child in content {
        validate_node(child, depth + 1)?;
    }
    Ok(())
}

pub fn plain_text(document: &Value) -> String {
    fn append(node: &Value, output: &mut String) {
        match kind(node) {
            "text" => {
                if let Some(text) = node.get("text").and_then(Value::as_str) {
                    output.push_str(text);
                }
            }
            "hardBreak" => output.push('\n'),
            "image" => output.push_str("[Image]\n"),
            _ => {
                if let Some(children) = node.get("content").and_then(Value::as_array) {
                    for child in children {
                        append(child, output);
                    }
                }
                if matches!(
                    kind(node),
                    "paragraph" | "heading" | "codeBlock" | "horizontalRule"
                ) {
                    output.push('\n');
                }
            }
        }
    }
    let mut text = String::new();
    append(document, &mut text);
    text
}

pub fn truncate(text: &str, limit: usize) -> String {
    text.graphemes(true).take(limit).collect()
}

pub fn summary(text: &str) -> (String, String) {
    let first = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    (
        if first.is_empty() {
            "Untitled note".into()
        } else {
            truncate(first, 160)
        },
        truncate(first, 120),
    )
}

pub fn snippet(text: &str, needle: &str) -> Vec<SnippetPart> {
    if needle.is_empty() {
        return vec![SnippetPart {
            text: truncate(text, 160),
            matched: false,
        }];
    }
    if text.is_ascii() && needle.is_ascii() {
        return ascii_snippet(text, needle);
    }
    // Each folded byte range points back to a whole original grapheme, including
    // expansions such as sharp-s and composed/decomposed accented characters.
    let graphemes = text.graphemes(true).collect::<Vec<_>>();
    let mut folded = String::new();
    let mut ranges = Vec::with_capacity(graphemes.len());
    for grapheme in &graphemes {
        let start = folded.len();
        if grapheme.is_ascii() {
            folded.extend(
                grapheme
                    .bytes()
                    .map(|byte| byte.to_ascii_lowercase() as char),
            );
        } else {
            folded.push_str(&search_key(grapheme));
        }
        ranges.push(start..folded.len());
    }
    let Some(found) = folded.find(needle) else {
        return vec![SnippetPart {
            text: truncate(text, 160),
            matched: false,
        }];
    };
    let first = ranges
        .iter()
        .position(|range| range.end > found)
        .unwrap_or(0);
    let last = ranges
        .iter()
        .position(|range| range.end >= found + needle.len())
        .map(|index| index + 1)
        .unwrap_or(graphemes.len());
    let start = first.saturating_sub(48);
    let end = (start + 160).min(graphemes.len());
    let matched_end = last.min(end);
    let mut parts = Vec::new();
    if start > 0 {
        parts.push(SnippetPart {
            text: "...".into(),
            matched: false,
        });
    }
    if start < first {
        parts.push(SnippetPart {
            text: graphemes[start..first].concat(),
            matched: false,
        });
    }
    parts.push(SnippetPart {
        text: graphemes[first..matched_end].concat(),
        matched: true,
    });
    if matched_end < end {
        parts.push(SnippetPart {
            text: graphemes[matched_end..end].concat(),
            matched: false,
        });
    }
    if end < graphemes.len() {
        parts.push(SnippetPart {
            text: "...".into(),
            matched: false,
        });
    }
    parts
}

fn ascii_snippet(text: &str, needle: &str) -> Vec<SnippetPart> {
    let Some(found) = text.to_ascii_lowercase().find(needle) else {
        return vec![SnippetPart {
            text: truncate(text, 160),
            matched: false,
        }];
    };
    let bytes = text.as_bytes();
    let splits_crlf = |position: usize| {
        position > 0
            && position < bytes.len()
            && bytes[position - 1] == b'\r'
            && bytes[position] == b'\n'
    };
    let first = found - usize::from(splits_crlf(found));
    let last = found + needle.len() + usize::from(splits_crlf(found + needle.len()));
    let start = first.saturating_sub(48);
    let start = start - usize::from(splits_crlf(start));
    let end = (start + 160).min(text.len());
    let end = end - usize::from(splits_crlf(end));
    let matched_end = last.min(end);
    let mut parts = Vec::new();
    if start > 0 {
        parts.push(SnippetPart {
            text: "...".into(),
            matched: false,
        });
    }
    if start < first {
        parts.push(SnippetPart {
            text: text[start..first].into(),
            matched: false,
        });
    }
    parts.push(SnippetPart {
        text: text[first..matched_end].into(),
        matched: true,
    });
    if matched_end < end {
        parts.push(SnippetPart {
            text: text[matched_end..end].into(),
            matched: false,
        });
    }
    if end < text.len() {
        parts.push(SnippetPart {
            text: "...".into(),
            matched: false,
        });
    }
    parts
}
