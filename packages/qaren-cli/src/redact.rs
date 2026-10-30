static REDACTION_KEY: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();

pub(crate) fn set_redaction_key(key: Option<String>) {
    let _ = REDACTION_KEY.set(key);
}

pub fn redact_api_key(raw: &str) -> String {
    match REDACTION_KEY.get() {
        Some(key) => redact_known_key(raw, key.as_deref()),
        None => redact_known_key(raw, std::env::var("TYPESAFE_API_KEY").ok().as_deref()),
    }
}

pub fn redact_known_key(raw: &str, key: Option<&str>) -> String {
    let Some(key) = key.filter(|k| !k.is_empty()) else {
        return raw.to_string();
    };
    let encoded = serde_json::to_string(key).unwrap_or_default();
    raw.replace(&encoded[1..encoded.len() - 1], "[REDACTED_SECRET]")
        .replace(key, "[REDACTED_SECRET]")
}

pub(crate) fn github_auth_values() -> Vec<String> {
    let mut values: Vec<_> = ["GH_TOKEN", "GITHUB_TOKEN"]
        .iter()
        .filter_map(|name| std::env::var(name).ok())
        .filter(|value| !value.is_empty())
        .collect();
    values.sort_by_key(|value| std::cmp::Reverse(value.len()));
    values
}

pub(crate) fn redact_github_tokens(raw: &str) -> String {
    github_auth_values()
        .iter()
        .fold(raw.to_string(), |text, value| {
            redact_known_key(&text, Some(value))
        })
}

// Contains the phrase itself, so withholding is a fixed point for every later check.
pub const PRIVATE_KEY_WITHHELD: &str = "[output withheld: contained private key material]";

pub fn names_private_key(text: &str) -> bool {
    text.as_bytes()
        .windows(11)
        .any(|w| w.eq_ignore_ascii_case(b"private key"))
}

#[derive(Debug, Clone, Eq, serde::Serialize)]
#[serde(transparent)]
pub struct OutputText(String);

impl OutputText {
    pub fn from_output(raw: &str) -> Self {
        Self(redact_secrets(raw))
    }

    pub(crate) fn from_admission(summary: &crate::core::AdmissionSummary) -> Self {
        // Preserve closed probe facts when an input matches an enum word.
        Self(summary.note())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> serde::Deserialize<'de> for OutputText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = <String as serde::Deserialize>::deserialize(deserializer)?;
        Ok(Self::from_output(&raw))
    }
}

impl std::ops::Deref for OutputText {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl AsRef<str> for OutputText {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl<T: AsRef<str> + ?Sized> PartialEq<T> for OutputText {
    fn eq(&self, other: &T) -> bool {
        self.0 == other.as_ref()
    }
}

impl std::fmt::Display for OutputText {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn redact_secrets(raw: &str) -> String {
    if names_private_key(raw) {
        return PRIVATE_KEY_WITHHELD.to_string();
    }
    redact_plain(raw)
}

// Ledger and receipt evidence only; operational records must preserve exact identities.
pub fn durable_json<T: serde::Serialize>(value: &T) -> serde_json::Result<String> {
    let mut projected = serde_json::to_value(value)?;
    let mut media = Vec::new();
    if let Some(value) = projected.get("mediaWithheld") {
        if let Ok(value) = serde_json::from_value::<crate::core::MediaWithheld>(value.clone()) {
            media.push(("/mediaWithheld".to_string(), serde_json::to_value(value)?));
        }
    }
    if let Some(note) = projected
        .pointer("/outcomes/video_policy")
        .and_then(serde_json::Value::as_str)
    {
        if ["strict", "non-strict", "undeclared"].contains(&note) {
            media.push(("/outcomes/video_policy".into(), note.into()));
        }
    }
    if let Some(steps) = projected.get("steps").and_then(serde_json::Value::as_array) {
        for (index, row) in steps.iter().enumerate() {
            if let Some(value) = row.get("screenshotWithheld") {
                if let Ok(cause) =
                    serde_json::from_value::<crate::core::WithholdCause>(value.clone())
                {
                    media.push((
                        format!("/steps/{index}/screenshotWithheld"),
                        serde_json::to_value(cause)?,
                    ));
                }
            }
        }
    }
    if let Some(note) = projected
        .pointer("/outcomes/media_withheld")
        .and_then(serde_json::Value::as_str)
    {
        if let Some(cause) = crate::core::MediaLatch::from_receipt_note(note) {
            media.push((
                "/outcomes/media_withheld".to_string(),
                cause.receipt_note().into(),
            ));
        }
    }
    for key in ["admission_before_deps", "admission_before_mutation"] {
        let pointer = format!("/outcomes/{key}");
        if let Some(summary) = projected
            .pointer(&pointer)
            .and_then(serde_json::Value::as_str)
            .and_then(crate::core::AdmissionSummary::from_note)
        {
            media.push((pointer, summary.note().into()));
        }
    }
    for pointer in ["/failure/evidence", "/evidence"] {
        if let Some(items) = projected
            .pointer(pointer)
            .and_then(serde_json::Value::as_array)
        {
            for (index, item) in items.iter().enumerate() {
                if let Some(summary) = item
                    .as_str()
                    .and_then(crate::core::AdmissionSummary::from_note)
                {
                    media.push((format!("{pointer}/{index}"), summary.note().into()));
                }
            }
        }
    }
    fn inputs(value: &mut serde_json::Value, path: &str, media: &[(String, serde_json::Value)]) {
        if let Some((_, closed)) = media.iter().find(|(pointer, _)| pointer == path) {
            *value = closed.clone();
            return;
        }
        match value {
            serde_json::Value::String(s) => *s = redact_github_tokens(&redact_inputs(s)),
            serde_json::Value::Array(items) => {
                for (index, item) in items.iter_mut().enumerate() {
                    inputs(item, &format!("{path}/{index}"), media);
                }
            }
            serde_json::Value::Object(map) => {
                *map = std::mem::take(map)
                    .into_iter()
                    .map(|(key, mut value)| {
                        let child = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
                        let closed = media.iter().any(|(pointer, _)| {
                            pointer == &child || pointer.starts_with(&format!("{child}/"))
                        });
                        if !value.is_string()
                            || ![
                                "verdict",
                                "result",
                                "code",
                                "schema",
                                "phase",
                                "kind",
                                "source",
                                "path",
                                "resolvedBy",
                                "outcome",
                                "videoPublication",
                                "videoPolicy",
                                "nonStrictPublication",
                                "method",
                            ]
                            .contains(&key.as_str())
                        {
                            inputs(&mut value, &child, media);
                        }
                        (
                            if closed {
                                key
                            } else {
                                redact_github_tokens(&redact_inputs(&key))
                            },
                            value,
                        )
                    })
                    .collect();
            }
            _ => {}
        }
    }
    inputs(&mut projected, "", &media);
    let value = &projected;
    let text = serde_json::to_string_pretty(value)?;
    if !names_private_key(&text) {
        return Ok(text);
    }
    fn withhold(value: &mut serde_json::Value) {
        match value {
            serde_json::Value::String(s) if names_private_key(s) => {
                *s = PRIVATE_KEY_WITHHELD.to_string();
            }
            serde_json::Value::Array(items) => items.iter_mut().for_each(withhold),
            serde_json::Value::Object(map) => {
                *map = std::mem::take(map)
                    .into_iter()
                    .map(|(key, mut item)| {
                        withhold(&mut item);
                        let key = if names_private_key(&key) {
                            PRIVATE_KEY_WITHHELD.to_string()
                        } else {
                            key
                        };
                        (key, item)
                    })
                    .collect();
            }
            _ => {}
        }
    }
    let mut value = serde_json::to_value(value)?;
    withhold(&mut value);
    serde_json::to_string_pretty(&value)
}

pub fn redact_plain(raw: &str) -> String {
    let safe = redact_github_tokens(&redact_inputs(&redact_api_key(raw)));
    let raw = safe.as_str();
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(idx) = rest.find("://") {
        let (head, tail) = rest.split_at(idx + 3);
        out.push_str(head);
        if let Some(at) = tail.find('@') {
            let userinfo = &tail[..at];
            if !userinfo.contains('/') && !userinfo.contains(' ') {
                out.push_str("<redacted>@");
                rest = &tail[at + 1..];
                continue;
            }
        }
        rest = tail;
    }
    out.push_str(rest);
    let token_like = |t: &str| {
        (t.starts_with("npm_") && t.len() > 20)
            || t.starts_with("ghp_")
            || t.starts_with("gho_")
            || t.starts_with("ghs_")
            || t.starts_with("github_pat_")
    };
    let mut redacted = String::with_capacity(out.len());
    let mut redact_next = false;
    // Quotes and brackets around a token are kept but never hide it.
    let wrap = |c: char| {
        matches!(
            c,
            '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';'
        )
    };
    for token in out.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let ws = &token[trimmed.len()..];
        let core = trimmed.trim_start_matches(wrap);
        let pre = &trimmed[..trimmed.len() - core.len()];
        // Unopened trailing quotes stay part of the value, as in `password="x"`.
        let core = if pre.is_empty() {
            core
        } else {
            core.trim_end_matches(wrap)
        };
        let suf = &trimmed[pre.len() + core.len()..];
        // npmrc-style assignments carry the value inline or as the next token.
        let assignment = core.split_once('=').filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            key.ends_with("authtoken")
                || key.ends_with("_auth")
                || key.ends_with("password")
                || key.ends_with("token")
                || key.ends_with("api_key")
        });
        if redact_next && !core.is_empty() {
            redacted.push_str(pre);
            redacted.push_str("<redacted>");
            redacted.push_str(suf);
            redacted.push_str(ws);
            redact_next = false;
        } else if let Some((key, value)) = assignment {
            redacted.push_str(pre);
            redacted.push_str(key);
            redacted.push('=');
            redacted.push_str(if value.is_empty() { "" } else { "<redacted>" });
            redacted.push_str(suf);
            redact_next = value.is_empty();
            redacted.push_str(ws);
        } else if token_like(core) {
            redacted.push_str(pre);
            redacted.push_str("<redacted>");
            redacted.push_str(suf);
            redacted.push_str(ws);
        } else if matches!(core.to_ascii_lowercase().as_str(), "bearer" | "basic") {
            redacted.push_str(trimmed);
            redacted.push_str(ws);
            redact_next = true;
        } else {
            redacted.push_str(token);
        }
    }
    redacted
}

// Public text leaves the machine: hostname, home, absolute paths, UUIDs and LAN addresses go.
#[derive(Debug, Clone, Default)]
pub struct MachineIdentity {
    pub hostname: Option<String>,
    pub home: Option<String>,
    pub username: Option<String>,
    // The run's own device ids, serials and ports, recorded by `qaren pr`.
    pub values: Vec<String>,
}

impl MachineIdentity {
    pub fn current() -> Self {
        MachineIdentity {
            hostname: hostname(),
            home: std::env::var("HOME").ok().filter(|h| h.len() > 1),
            username: username(),
            values: Vec::new(),
        }
    }

    pub fn with_values(&self, values: &[String]) -> Self {
        let mut machine = self.clone();
        machine.values.extend(values.iter().cloned());
        machine
    }
}

fn username() -> Option<String> {
    // SAFETY: getpwuid returns a pointer into static storage or null; the name is copied at once.
    unsafe {
        let entry = libc::getpwuid(libc::getuid());
        if entry.is_null() || (*entry).pw_name.is_null() {
            return None;
        }
        std::ffi::CStr::from_ptr((*entry).pw_name)
            .to_str()
            .ok()
            .filter(|name| !name.is_empty())
            .map(str::to_string)
    }
}

fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length; gethostname NUL-terminates within it.
    if unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } != 0 {
        return None;
    }
    let end = buf.iter().position(|b| *b == 0)?;
    String::from_utf8(buf[..end].to_vec())
        .ok()
        .filter(|h| !h.is_empty())
}

pub fn redact_machine(raw: &str, machine: &MachineIdentity) -> String {
    let mut text = redact_secrets(raw);
    if let Some(home) = &machine.home {
        text = text.replace(home.trim_end_matches('/'), "~");
    }
    text = redact_absolute_paths(&text);
    // Known values are replaced as whole words only; shorter than 3 characters is not masked.
    for value in &machine.values {
        if value.len() >= 3 {
            let label = if value.bytes().all(|b| b.is_ascii_digit()) {
                "<port>"
            } else {
                "<device>"
            };
            text = replace_ignore_ascii_case(&text, value, label);
        }
    }
    if let Some(user) = machine.username.as_ref().filter(|u| u.len() >= 3) {
        text = replace_ignore_ascii_case(&text, user, "<user>");
    }
    if let Some(host) = &machine.hostname {
        let short = host.split('.').next().unwrap_or(host);
        for name in [host.as_str(), short] {
            if name.len() >= 3 {
                text = replace_ignore_ascii_case(&text, name, "<host>");
            }
        }
    }
    redact_lan_ipv4(&redact_uuids(&text))
}

// Whole-name matches only, so a short hostname cannot eat part of an ordinary word.
fn replace_ignore_ascii_case(text: &str, needle: &str, with: &str) -> String {
    let lower = text.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let word = |b: Option<&u8>| b.is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'-');
    let bytes = lower.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut at, mut from) = (0, 0);
    while let Some(i) = lower[from..].find(&needle) {
        let start = from + i;
        let end = start + needle.len();
        from = start + lower[start..].chars().next().unwrap().len_utf8();
        if word(start.checked_sub(1).and_then(|p| bytes.get(p))) || word(bytes.get(end)) {
            continue;
        }
        out.push_str(&text[at..start]);
        out.push_str(with);
        at = end;
        from = end;
    }
    out.push_str(&text[at..]);
    out
}

fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '~' | '/' | '@' | '+')
}

// A path starts at a '/' that opens a token and spans at least two segments.
fn redact_absolute_paths(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let opens = i == 0
            || matches!(
                chars[i - 1],
                ' ' | '\t' | '\n' | '(' | '"' | '\'' | '`' | '[' | '=' | ','
            );
        if chars[i] == '/'
            && opens
            && chars
                .get(i + 1)
                .is_some_and(|c| is_path_char(*c) && *c != '/')
        {
            let mut j = i + 1;
            while j < chars.len() && is_path_char(chars[j]) {
                j += 1;
            }
            if chars[i + 1..j].contains(&'/') {
                out.push_str("<path>");
                i = j;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn redact_uuids(text: &str) -> String {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let bytes = text.as_bytes();
    let is_uuid_at = |start: usize| {
        let mut at = start;
        for (n, len) in GROUPS.iter().enumerate() {
            if at + len > bytes.len() || !bytes[at..at + len].iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            at += len;
            if n < 4 {
                if bytes.get(at) != Some(&b'-') {
                    return None;
                }
                at += 1;
            }
        }
        let bounded = |b: Option<&u8>| !b.is_some_and(|b| b.is_ascii_alphanumeric());
        (bounded(start.checked_sub(1).and_then(|p| bytes.get(p))) && bounded(bytes.get(at)))
            .then_some(at)
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(end) = is_uuid_at(i) {
            out.push_str("<id>");
            i = end;
        } else {
            let c = text[i..].chars().next().unwrap_or_default();
            out.push(c);
            i += c.len_utf8().max(1);
        }
    }
    out
}

fn is_lan(octets: [u8; 4]) -> bool {
    matches!(octets, [10, ..] | [192, 168, ..] | [169, 254, ..])
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
}

fn redact_lan_ipv4(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let starts = bytes[i].is_ascii_digit()
            && !(i > 0 && (bytes[i - 1].is_ascii_digit() || bytes[i - 1] == b'.'));
        if starts {
            let end = i + bytes[i..]
                .iter()
                .take_while(|b| b.is_ascii_digit() || **b == b'.')
                .count();
            let candidate = text[i..end].trim_end_matches('.');
            let octets: Vec<Option<u8>> = candidate.split('.').map(|p| p.parse().ok()).collect();
            if octets.len() == 4 && octets.iter().all(Option::is_some) {
                let o: Vec<u8> = octets.into_iter().flatten().collect();
                if is_lan([o[0], o[1], o[2], o[3]]) {
                    out.push_str("<lan>");
                    i += candidate.len();
                    continue;
                }
            }
            out.push_str(&text[i..end]);
            i = end;
            continue;
        }
        let c = text[i..].chars().next().unwrap_or_default();
        out.push(c);
        i += c.len_utf8().max(1);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        durable_json, redact_known_key, redact_machine, redact_secrets, MachineIdentity,
        PRIVATE_KEY_WITHHELD,
    };

    #[test]
    fn typesafe_key_is_redacted_without_a_prefix_and_in_json() {
        let key = "opaque-\"key\\value";
        let raw = format!(
            "plain {key} encoded {}",
            serde_json::to_string(key).unwrap()
        );
        let safe = redact_known_key(&raw, Some(key));
        assert!(!safe.contains("opaque"), "{safe}");
        assert_eq!(
            redact_secrets("TYPESAFE_API_KEY=secret"),
            "TYPESAFE_API_KEY=<redacted>"
        );
    }

    #[test]
    fn quoted_tokens_are_redacted_and_keep_their_quotes() {
        let raw = r#"type: "ghp_abcdefghijklmnopqrstuvwxyz0123" ('token=hunter2') [github_pat_x1]"#;
        assert_eq!(
            redact_secrets(raw),
            r#"type: "<redacted>" ('token=<redacted>') [<redacted>]"#
        );
    }

    #[test]
    fn redacts_url_userinfo_and_npm_tokens() {
        let raw = "fetch https://user:hunter2@registry.example.com/pkg failed npm_abcdefghijklmnopqrstuvwx123456789012 end";
        let clean = redact_secrets(raw);
        assert!(!clean.contains("hunter2"), "{clean}");
        assert!(
            !clean.contains("npm_abcdefghijklmnopqrstuvwx123456789012"),
            "{clean}"
        );
        assert!(clean.contains("registry.example.com"), "{clean}");
    }

    #[test]
    fn any_mention_of_a_private_key_withholds_the_whole_string() {
        for raw in [
            "-----BEGIN PRIVATE KEY-----\nFAKEKEYBODY\n-----END PRIVATE KEY-----\n",
            "FAKEKEYBODY\n-----END OPENSSH PRIVATE KEY----- tail",
            "FAKEKEYBODY\n<redacted private key>\n",
            "warning: this Private Key is ignored\nFAKEKEYBODY",
            PRIVATE_KEY_WITHHELD,
        ] {
            assert_eq!(redact_secrets(raw), PRIVATE_KEY_WITHHELD);
        }
    }

    #[test]
    fn durable_json_withholds_nested_strings_and_keys_only_when_named() {
        let plain = serde_json::json!({"b": 1, "a": ["x"]});
        assert_eq!(
            durable_json(&plain).unwrap(),
            serde_json::to_string_pretty(&plain).unwrap()
        );
        let leaky = serde_json::json!({
            "evidence": ["ok", "FAKEKEYBODY -----END private key-----"],
            "nested": {"PRIVATE KEY FAKEKEYBODY": "v", "keep": "plain"},
        });
        let text = durable_json(&leaky).unwrap();
        assert!(!text.contains("FAKEKEYBODY"), "{text}");
        assert!(text.contains("\"plain\""), "{text}");
    }

    #[test]
    fn non_key_text_passes_byte_identical() {
        for plain in [
            "commit 0123456789abcdef0123456789abcdef01234567 built\n",
            "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----\n",
            "BUILD SUCCEEDED\r\n[1/3] Compiling\n",
        ] {
            assert_eq!(redact_secrets(plain), plain);
        }
    }

    #[test]
    fn plain_urls_survive_redaction() {
        let raw = "GET https://registry.npmjs.org/react 200";
        assert_eq!(redact_secrets(raw), raw);
    }

    #[test]
    fn rejected_multibyte_names_preserve_boundaries_and_later_matches() {
        let machine = MachineIdentity {
            values: vec!["Антон".into(), "设备".into()],
            username: Some("用户".into()),
            hostname: Some("主机.local".into()),
            ..Default::default()
        };
        assert_eq!(
            redact_machine(
                "Антон-ios Антон; 设备-ios 设备; 用户-ios 用户; 主机.local-ios 主机.local 主机-ios 主机",
                &machine,
            ),
            "Антон-ios <device>; 设备-ios <device>; 用户-ios <user>; <host>.local-ios <host> 主机-ios <host>"
        );
    }

    #[test]
    fn identity_matching_keeps_ascii_case_and_word_boundaries() {
        let machine = MachineIdentity {
            values: vec!["Device".into()],
            username: Some("Alice".into()),
            hostname: Some("Mac.local".into()),
            ..Default::default()
        };
        assert_eq!(
            redact_machine(
                "Device-ios DEVICE xDevice Alice-ios ALICE Mac-ios MAC.local macOS MAC",
                &machine
            ),
            "Device-ios <device> xDevice Alice-ios <user> Mac-ios <host> macOS <host>"
        );
    }

    #[test]
    fn machine_identity_is_removed_from_public_text() {
        let machine = MachineIdentity {
            hostname: Some("Work-MacBook-Pro.local".into()),
            home: Some("/Users/alice".into()),
            ..Default::default()
        };
        let raw = "on work-macbook-pro at /Users/alice/app/plan.md and /private/var/x.log, sim 1DC408C4-51DA-4C4F-ACA1-39881C916FDD via 192.168.1.20:8081, 10.0.0.7, 172.20.1.1 and 169.254.3.4; keep 8.8.8.8, 172.32.0.1, https://github.com/o/r/pull/12, ./media/video.mp4 and 1.2.3.4.5";
        let clean = redact_machine(raw, &machine);
        for leak in [
            "macbook", "alice", "/Users", "/private", "1DC408C4", "192.168", "10.0.0.7", "172.20",
            "169.254",
        ] {
            assert!(
                !clean
                    .to_ascii_lowercase()
                    .contains(&leak.to_ascii_lowercase()),
                "{leak}: {clean}"
            );
        }
        for kept in [
            "8.8.8.8",
            "172.32.0.1",
            "https://github.com/o/r/pull/12",
            "./media/video.mp4",
        ] {
            assert!(clean.contains(kept), "{kept}: {clean}");
        }
        assert_eq!(redact_machine(&clean, &machine), clean);
        let short = MachineIdentity {
            hostname: Some("mac.local".into()),
            home: None,
            ..Default::default()
        };
        assert_eq!(
            redact_machine("macOS on mac, MAC.local", &short),
            "macOS on <host>, <host>"
        );
    }

    #[test]
    fn a_padded_declared_input_is_redacted_in_its_trimmed_form() {
        let inputs = super::InputValues::from_values(vec![" Alice Example ".to_string()]);
        let clean = inputs.redact("Signed in as Alice Example");
        assert_eq!(clean, "Signed in as [REDACTED_INPUT]");
    }

    #[test]
    fn declared_inputs_are_redacted_in_any_letter_case_without_touching_the_marker() {
        let inputs = super::InputValues::from_values(vec![
            "QATESTER@EXAMPLE.TEST".to_string(),
            "Input".to_string(),
        ]);
        let clean = inputs
            .redact("signed in as qatester@example.test; Qatester at Example.Test; INPUT set");
        for leaked in [
            "qatester@example.test",
            "Qatester",
            "Example.Test",
            "INPUT set",
        ] {
            assert!(!clean.contains(leaked), "{leaked}: {clean}");
        }
        assert_eq!(clean.matches("[REDACTED_INPUT]").count(), 4, "{clean}");
        assert!(
            clean.starts_with("signed in as [REDACTED_INPUT]; "),
            "{clean}"
        );
    }
    #[test]
    fn unicode_input_casing_redacts_original_spans_in_both_directions() {
        for (declared, variant) in [
            ("Hauptstraße 42", "HAUPTSTRASSE 42"),
            ("JÖRG", "jörg"),
            ("ΟΣ", "ος"),
            ("İSİM", "i\u{307}si\u{307}m"),
            ("𐐀𐐁𐐂", "𐐨𐐩𐐪"),
            ("JÖRG@EXAMPLE.TEST", "jörg@example.test"),
        ] {
            for (value, echo) in [(declared, variant), (variant, declared)] {
                let inputs = super::InputValues::from_values(vec![value.into()]);
                let raw = format!("🌍 before {echo}; {echo} after é");
                assert_eq!(
                    inputs.redact(&raw),
                    "🌍 before [REDACTED_INPUT]; [REDACTED_INPUT] after é"
                );
            }
        }
    }
}

pub struct InputValues {
    entries: std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
    test_pii_only: std::sync::atomic::AtomicBool,
}

pub struct ResolvedInputs<'a> {
    owner: &'a InputValues,
    names: Vec<String>,
}

impl InputValues {
    pub fn capture() -> Self {
        Self::from_entries(std::env::vars_os())
    }

    pub fn from_entries(
        entries: impl IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
    ) -> Self {
        Self {
            entries: entries
                .into_iter()
                .filter(|(key, _)| key.as_encoded_bytes().starts_with(b"QAREN_INPUT_"))
                .collect(),
            test_pii_only: Default::default(),
        }
    }

    // A log helper's redaction scope: values only, never consulted for withholding.
    pub fn from_values(values: Vec<String>) -> Self {
        Self::from_entries(
            values
                .into_iter()
                .enumerate()
                .map(|(i, value)| (format!("QAREN_INPUT_{i}").into(), value.into())),
        )
    }

    pub fn has_namespace(&self) -> bool {
        !self.entries.is_empty()
    }

    fn values(&self) -> Vec<String> {
        self.entries
            .values()
            .filter_map(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .map(String::from)
            .collect()
    }

    pub fn admit(&self, names: &[String]) -> Result<ResolvedInputs<'_>, crate::failure::Failure> {
        use crate::failure::{Failure, FailureCode};
        let invalid = || {
            Failure::new(
                "preflight",
                FailureCode::CoreRefused,
                "runtime inputs are invalid",
                "supply bounded owner-resolved runtime inputs",
            )
        };
        let names: Vec<String> = names
            .iter()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        if names.len() > 64 || names.iter().any(|name| !valid_input_name(name)) {
            return Err(invalid());
        }
        let missing: Vec<_> = names
            .iter()
            .filter(|name| {
                self.entries
                    .get(&std::ffi::OsString::from(format!("QAREN_INPUT_{name}")))
                    .is_none_or(|value| value.is_empty())
            })
            .cloned()
            .collect();
        if !missing.is_empty() {
            return Err(Failure::new(
                "preflight",
                FailureCode::PlanInputMissing,
                format!(
                    "required runtime inputs are missing: {}",
                    self.redact(&missing.join(", "))
                ),
                "set the required QAREN_INPUT_<NAME> variables and re-run",
            ));
        }
        let mut total = 0;
        for name in &names {
            let value = self
                .entries
                .get(&std::ffi::OsString::from(format!("QAREN_INPUT_{name}")))
                .and_then(|value| value.to_str())
                .ok_or_else(invalid)?;
            total += value.len();
            let scheme = value.split_once(':').is_some_and(|(prefix, _)| {
                !prefix.is_empty()
                    && prefix.as_bytes()[0].is_ascii_alphabetic()
                    && prefix
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b))
            });
            if value.len() > 4096
                || value.trim().chars().count() < 3
                || total > 65536
                || value.bytes().any(|b| b < 32 || b == 127)
                || scheme
                || ["${", "$(", "{{"]
                    .iter()
                    .any(|pattern| value.contains(pattern))
            {
                return Err(invalid());
            }
        }
        Ok(ResolvedInputs { owner: self, names })
    }

    pub fn redact(&self, raw: &str) -> String {
        let mut forms: Vec<String> = self
            .values()
            .into_iter()
            .flat_map(|value| {
                let encoded = serde_json::to_string(&value).unwrap_or_default();
                let mut forms = email_forms(&value);
                forms.extend([
                    encoded[1..encoded.len() - 1].to_string(),
                    value.trim().to_string(),
                    value,
                ]);
                forms.retain(|form| !form.is_empty());
                forms
            })
            .collect();
        forms.sort_by_key(|value| std::cmp::Reverse(value.len()));
        forms.dedup();
        let fold = |text: &str| -> String {
            text.chars()
                .flat_map(|c| c.to_uppercase().flat_map(char::to_lowercase))
                .collect()
        };
        let mut hay = String::new();
        let mut offsets = Vec::new();
        for (start, c) in raw.char_indices() {
            let folded = fold(&c.to_string());
            offsets.extend(std::iter::repeat_n(
                (start, start + c.len_utf8()),
                folded.len(),
            ));
            hay.push_str(&folded);
        }
        let mut spans: Vec<(usize, usize)> = Vec::new();
        for form in forms {
            for (start, found) in hay.match_indices(&fold(&form)) {
                let end = offsets[start + found.len() - 1].1;
                let start = offsets[start].0;
                if spans.iter().all(|&(a, b)| end <= a || start >= b) {
                    spans.push((start, end));
                }
            }
        }
        spans.sort_unstable();
        let mut out = String::with_capacity(raw.len());
        let mut at = 0;
        for (start, end) in spans {
            out.push_str(&raw[at..start]);
            out.push_str("[REDACTED_INPUT]");
            at = end;
        }
        out.push_str(&raw[at..]);
        out
    }
}

pub fn valid_input_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && name.as_bytes()[0].is_ascii_uppercase()
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

impl ResolvedInputs<'_> {
    pub fn has_inputs(&self) -> bool {
        !self.names.is_empty()
    }
    pub fn declare_test_pii(&self, test_pii: &[String]) {
        let only = self.has_inputs()
            && self.owner.entries.keys().all(|key| {
                key.to_str()
                    .and_then(|key| key.strip_prefix("QAREN_INPUT_"))
                    .is_some_and(|name| {
                        self.names.iter().any(|n| n == name) && test_pii.iter().any(|n| n == name)
                    })
            });
        self.owner
            .test_pii_only
            .store(only, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn names(&self) -> &[String] {
        &self.names
    }
    pub fn write_private(
        &self,
        writer: &mut impl std::io::Write,
        public: &impl serde::Serialize,
        run_id: Option<&str>,
    ) -> std::io::Result<()> {
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Payload<'a, T: serde::Serialize> {
            #[serde(flatten)]
            public: &'a T,
            input_protocol: u8,
            inputs: std::collections::BTreeMap<&'a str, &'a str>,
        }
        #[derive(serde::Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Envelope<'a, T: serde::Serialize> {
            v: u8,
            run_id: &'a str,
            seq: u8,
            r#type: &'static str,
            payload: T,
        }
        let values = self
            .names
            .iter()
            .map(|name| {
                let value = self
                    .owner
                    .entries
                    .get(&std::ffi::OsString::from(format!("QAREN_INPUT_{name}")))
                    .and_then(|value| value.to_str())
                    .expect("admitted immutable runtime input");
                (name.as_str(), value)
            })
            .collect();
        let payload = Payload {
            public,
            input_protocol: 1,
            inputs: values,
        };
        let mut bytes = match run_id {
            Some(run_id) => serde_json::to_vec(&Envelope {
                v: 1,
                run_id,
                seq: 1,
                r#type: "request",
                payload,
            }),
            None => serde_json::to_vec(&payload),
        }
        .map_err(|_| std::io::Error::other("runtime input transport failed"))?;
        bytes.push(b'\n');
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(std::io::Error::other("private request exceeds limit"));
        }
        writer.write_all(&bytes)
    }
}

thread_local! { static INPUT_SCOPE: std::cell::RefCell<Option<std::sync::Arc<InputValues>>> = const { std::cell::RefCell::new(None) }; }

pub fn capture_input_scope() -> Option<std::sync::Arc<InputValues>> {
    INPUT_SCOPE.with(|scope| scope.borrow().clone())
}

pub fn with_input_scope<T>(
    inputs: std::sync::Arc<InputValues>,
    operation: impl FnOnce() -> T,
) -> T {
    struct Restore(Option<std::sync::Arc<InputValues>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            INPUT_SCOPE.with(|scope| *scope.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(INPUT_SCOPE.with(|scope| scope.replace(Some(inputs))));
    operation()
}

pub fn private_output_mode() -> bool {
    capture_input_scope().is_some_and(|scope| {
        scope.has_namespace()
            && !scope
                .test_pii_only
                .load(std::sync::atomic::Ordering::SeqCst)
    })
}

pub fn input_namespace_present() -> bool {
    capture_input_scope().is_some_and(|scope| scope.has_namespace())
}

// What a log helper must redact when its output is not withheld.
pub fn log_redaction_values() -> Vec<String> {
    if private_output_mode() {
        return Vec::new();
    }
    capture_input_scope().map_or_else(Vec::new, |scope| scope.values())
}

// Apps show a declared e-mail in parts or encoded, so each derived form is redacted with it.
fn email_forms(value: &str) -> Vec<String> {
    let whole = value.trim();
    let Some((local, domain)) = whole.split_once('@') else {
        return Vec::new();
    };
    if local.is_empty()
        || domain.contains('@')
        || !domain.trim_matches('.').contains('.')
        || whole.chars().any(char::is_whitespace)
    {
        return Vec::new();
    }
    let percent = |text: &str| {
        text.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect::<String>()
    };
    let mut forms = vec![
        percent(whole),
        whole.replacen('@', "&#64;", 1),
        whole.replacen('@', "&#x40;", 1),
        whole.replacen('@', "&commat;", 1),
        local.to_string(),
        percent(local),
        local.split('+').next().unwrap_or(local).to_string(),
        domain.to_string(),
    ];
    forms.retain(|form| form.chars().count() >= 3 && form != whole);
    forms
}

pub fn redact_inputs(raw: &str) -> String {
    capture_input_scope().map_or_else(|| raw.to_string(), |scope| scope.redact(raw))
}

pub(crate) fn deserialize_registry_auth_env<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    let items = <Vec<serde_json::Value> as serde::Deserialize>::deserialize(deserializer)?;
    items
        .into_iter()
        .map(|item| match item {
            serde_json::Value::String(name) => Ok(name),
            _ => Err(serde::de::Error::custom(
                "registry auth environment requires a list of strings",
            )),
        })
        .collect()
}

pub fn valid_registry_auth_env_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    let mut bytes = name.bytes();
    name.len() <= 128
        && bytes
            .next()
            .is_some_and(|b| b.is_ascii_alphabetic() || b == b'_')
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && upper != "TYPESAFE_API_KEY"
        && !upper.starts_with("QAREN_INPUT_")
}

pub fn valid_registry_auth_env_names(names: &[String]) -> bool {
    names.len() <= 64 && names.iter().all(|name| valid_registry_auth_env_name(name))
}

pub(crate) fn is_registry_child(label: &str) -> bool {
    matches!(label, "pnpm-install" | "expo-prebuild")
}

pub fn scrub_secret_env(
    command: &mut std::process::Command,
    label: &str,
    registry_auth_env: &[String],
) {
    let keys: std::collections::BTreeSet<_> = std::env::vars_os()
        .map(|(key, _)| key)
        .chain(command.get_envs().map(|(key, _)| key.to_owned()))
        .filter(|key| {
            let name = key.as_encoded_bytes().to_ascii_uppercase();
            let secret = name.starts_with(b"QAREN_INPUT_")
                || [b"TOKEN".as_slice(), b"_API_KEY", b"APIKEY"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
                || [
                    b"SECRET".as_slice(),
                    b"PASSWORD",
                    b"PASSWD",
                    b"_CREDENTIALS",
                    b"_PRIVATE_KEY",
                ]
                .iter()
                .any(|part| name.windows(part.len()).any(|window| window == *part));
            let model =
                key == "TYPESAFE_API_KEY" && matches!(label, "core-walk" | "plan-preflight");
            let github = crate::github::is_github_child(label)
                && (key == "GH_TOKEN" || key == "GITHUB_TOKEN");
            let registry = is_registry_child(label)
                && ([
                    "NPM_TOKEN",
                    "NODE_AUTH_TOKEN",
                    "YARN_NPM_AUTH_TOKEN",
                    "COREPACK_NPM_TOKEN",
                    "GITHUB_TOKEN",
                    "GH_TOKEN",
                ]
                .iter()
                .any(|allowed| key == *allowed)
                    || (valid_registry_auth_env_names(registry_auth_env)
                        && registry_auth_env
                            .iter()
                            .any(|allowed| key.as_os_str() == std::ffi::OsStr::new(allowed))));
            secret && !model && !registry && !github
        })
        .collect();
    for key in keys {
        command.env_remove(key);
    }
}
