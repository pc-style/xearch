use std::{
    io::{Seek, Write},
    process::{Command, Stdio},
};

#[test]
fn terminal_receipt_only_after_valid_complete_export() {
    let good = serde_json::json!({"id":"1","text":"hello","author":{"id":"2","screen_name":"a"}});
    let mut input = tempfile::NamedTempFile::new().unwrap();
    write!(
        input,
        "{}",
        serde_json::json!({"records":[{"receivedAt":42,"payload":{"posts":[good,{"id":"bad"}]}},{"payload":{"type":"profile"}}]})
    )
    .unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_xearch-export"))
        .arg(input.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    let text = String::from_utf8(output.stdout).unwrap();
    let rows: Vec<serde_json::Value> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows.first().unwrap().get("observedAtMs"),
        Some(&serde_json::json!(42))
    );
    let receipt = rows.last().unwrap();
    assert_eq!(receipt.get("type"), Some(&serde_json::json!("receipt")));
    assert_eq!(receipt.get("rejected"), Some(&serde_json::json!(1)));

    input.as_file_mut().set_len(0).unwrap();
    input.as_file_mut().rewind().unwrap();
    write!(input, "{{\"posts\":[{good}]").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_xearch-export"))
        .arg(input.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(
        !String::from_utf8(output.stdout)
            .unwrap()
            .contains("\"receipt\"")
    );
}

#[test]
fn closed_stdout_is_a_failed_export() {
    let mut input = tempfile::NamedTempFile::new().unwrap();
    let good = serde_json::json!({"id":"1","text":"x".repeat(16384),"author":{"id":"2","screen_name":"a"}});
    write!(input, "{}", serde_json::json!({"posts":[good]})).unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_xearch-export"))
        .arg(input.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(child.stdout.take());
    assert!(!child.wait().unwrap().success());
}
