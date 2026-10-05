//! Runs the shared reader-set cases in `fixtures/reader-sets.json`.
//!
//! Keeper's TypeScript port (`keeper/src/ifc/labels.ts`) runs the same file,
//! so the two implementations cannot drift apart.

use std::collections::BTreeSet;

use ifc_core::ReaderSet;
use serde_json::Value;

fn reader_set(value: &Value) -> ReaderSet<String> {
    match value {
        Value::String(text) if text == "everyone" => ReaderSet::Everyone,
        Value::Array(readers) => ReaderSet::Only(
            readers
                .iter()
                .map(|reader| reader.as_str().expect("principal").to_owned())
                .collect::<BTreeSet<_>>(),
        ),
        other => panic!("invalid reader set {other}"),
    }
}

fn fixtures() -> Value {
    serde_json::from_str(include_str!("../fixtures/reader-sets.json")).expect("valid fixture JSON")
}

#[test]
fn can_flow_to_cases() {
    let fixtures = fixtures();
    let cases = fixtures["canFlowTo"].as_array().expect("canFlowTo cases");
    assert!(!cases.is_empty());
    for case in cases {
        let source = reader_set(&case["source"]);
        let destination = reader_set(&case["destination"]);
        assert_eq!(
            source.can_flow_to(&destination),
            case["expected"].as_bool().expect("expected"),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn join_cases() {
    let fixtures = fixtures();
    let cases = fixtures["join"].as_array().expect("join cases");
    assert!(!cases.is_empty());
    for case in cases {
        let joined = reader_set(&case["left"]).join(&reader_set(&case["right"]));
        assert_eq!(joined, reader_set(&case["expected"]), "{}", case["name"]);
    }
}
