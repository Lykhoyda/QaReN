use qaren::record::{NonStrictPublication, VideoPolicy, VideoPublication};

fn verdicts() -> [VideoPublication; 4] {
    [
        VideoPublication::Eligible,
        VideoPublication::WithheldFill,
        VideoPublication::WithheldPrivacy,
        VideoPublication::Unknown,
    ]
}

fn non_strict_verdicts() -> [Option<NonStrictPublication>; 3] {
    [
        None,
        Some(NonStrictPublication::Eligible),
        Some(NonStrictPublication::WithheldSecret),
    ]
}

#[test]
fn strict_and_undeclared_use_only_the_strict_verdict() {
    for policy in [VideoPolicy::Undeclared, VideoPolicy::Strict] {
        for strict in verdicts() {
            for non_strict in non_strict_verdicts() {
                assert_eq!(policy.publication(&strict, non_strict.as_ref()), strict);
            }
        }
    }
}

#[test]
fn non_strict_uses_its_own_verdict_only_when_the_strict_verdict_is_known() {
    let cases = [
        (None, VideoPublication::Unknown),
        (
            Some(NonStrictPublication::Eligible),
            VideoPublication::Eligible,
        ),
        (
            Some(NonStrictPublication::WithheldSecret),
            VideoPublication::WithheldPrivacy,
        ),
    ];
    for strict in [
        VideoPublication::Eligible,
        VideoPublication::WithheldFill,
        VideoPublication::WithheldPrivacy,
    ] {
        for (non_strict, expected) in &cases {
            assert_eq!(
                VideoPolicy::NonStrict.publication(&strict, non_strict.as_ref()),
                *expected
            );
        }
    }
}

#[test]
fn unknown_policy_or_strict_verdict_always_withholds() {
    for non_strict in non_strict_verdicts() {
        assert_eq!(
            VideoPolicy::NonStrict.publication(&VideoPublication::Unknown, non_strict.as_ref()),
            VideoPublication::Unknown
        );
        for strict in verdicts() {
            assert_eq!(
                VideoPolicy::Unknown.publication(&strict, non_strict.as_ref()),
                VideoPublication::Unknown
            );
        }
    }
}
