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
fn the_dev_mode_default_uses_the_non_strict_verdict_and_rules() {
    for strict in verdicts() {
        for non_strict in non_strict_verdicts() {
            assert_eq!(
                VideoPolicy::DefaultNonStrict.publication(&strict, non_strict.as_ref()),
                VideoPolicy::NonStrict.publication(&strict, non_strict.as_ref())
            );
        }
    }
    assert_eq!(VideoPolicy::DefaultNonStrict.rules(), VideoPolicy::NonStrict);
    assert_eq!(VideoPolicy::Undeclared.rules(), VideoPolicy::Strict);
    assert_eq!(VideoPolicy::DefaultNonStrict.as_str(), "default-non-strict");
    assert_eq!(
        serde_json::to_value(VideoPolicy::DefaultNonStrict).unwrap(),
        "default-non-strict"
    );
    assert_eq!(
        serde_json::from_value::<VideoPolicy>("default-non-strict".into()).unwrap(),
        VideoPolicy::DefaultNonStrict
    );
}

#[test]
fn the_dev_mode_word_survives_input_redaction_in_the_receipt() {
    use qaren::receipt::{Receipt, ReceiptResult};
    let mut receipt = Receipt::new("check", "run", ReceiptResult::Pass, "cleaned", "t".into());
    receipt
        .outcomes
        .insert("video_policy".into(), "default-non-strict".into());
    let inputs = std::sync::Arc::new(qaren::redact::InputValues::from_entries(vec![(
        "QAREN_INPUT_SYNTHETIC".into(),
        "default-non-strict".into(),
    )]));
    let json = qaren::redact::with_input_scope(inputs, || receipt.to_json());
    let json: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(json["outcomes"]["video_policy"], "default-non-strict");
}

// AI-725: the public text of every closed unavailable-video reason.
#[test]
fn every_unavailable_video_reason_has_its_fixed_public_text() {
    use qaren::record::VideoReason;
    for (reason, text) in [
        (VideoReason::NotRecorded, "no capture was written"),
        (VideoReason::RecorderFailed, "the recorder failed"),
        (VideoReason::FfmpegMissing, "ffmpeg"),
        (VideoReason::EncodeFailed, "encode failed"),
        (VideoReason::NoPlayableDuration, "ffprobe found no playable duration"),
        (VideoReason::Cancelled, "the run was cancelled"),
        (VideoReason::RuntimeInputWithheld, "runtime inputs withhold recording"),
        (VideoReason::Interrupted, "app continuity was interrupted after admission"),
        (VideoReason::NoAdmittedFrame, "no admitted app frame was recorded"),
        (VideoReason::NoWindow, "no positive publication window was recorded"),
        (VideoReason::TrimFailed, "the admitted part of the recording could not be prepared"),
        (VideoReason::AndroidUnsupported, "Android API <34 stops screen recording at 180 s"),
        (VideoReason::PublishedCopyMissing, "published recording is unavailable"),
        (VideoReason::Other, "the recorder did not produce a publishable video"),
    ] {
        assert_eq!(reason.public_detail(), text, "{}", reason.as_str());
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
