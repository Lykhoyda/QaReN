const EXPO_LAUNCH_SWITCHES: &str =
    "__expo_disable_onboarding=1&__expo_disable_fab=1&__expo_disable_auto_launch=1";

pub fn metro_launch_url(metro_port: u16) -> String {
    format!("http://127.0.0.1:{metro_port}/?disableOnboarding=1&{EXPO_LAUNCH_SWITCHES}")
}

fn percent_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len() * 3);
    for byte in raw.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub fn launch_url(scheme: &str, metro_port: u16) -> String {
    format!(
        "{scheme}://expo-development-client/?{EXPO_LAUNCH_SWITCHES}&url={}",
        percent_encode(&metro_launch_url(metro_port))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_url_pins_the_run_metro() {
        assert_eq!(
            launch_url("rndatest", 8791),
            "rndatest://expo-development-client/?__expo_disable_onboarding=1&__expo_disable_fab=1&__expo_disable_auto_launch=1&url=http%3A%2F%2F127.0.0.1%3A8791%2F%3FdisableOnboarding%3D1%26__expo_disable_onboarding%3D1%26__expo_disable_fab%3D1%26__expo_disable_auto_launch%3D1"
        );
    }
}
