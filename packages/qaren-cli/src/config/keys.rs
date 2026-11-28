// States what is wrong with the keys of a check configuration that did not parse.
// Every word it returns is fixed text, a key this build reads, or a number: never text from the file.
// It states facts about keys (which key, and where this build reads that name) and never how to
// edit the file, never judges a value, and judges keys only in a file where a second read cannot
// disagree with the loader: one without `!`, the mark of a YAML tag.
use super::{AndroidConfig, BuildConfig, CheckConfig, IosConfig, LoginMarker, Named};
use crate::scenario::{Deadlines, IosWorkspaceBuild};
use serde::de::IgnoredAny;
use serde::Deserialize;
use serde_yaml::{Mapping, Value};

// At most this many different faults are spelled out; the rest are counted.
const SPELLED_OUT: usize = 3;

type Block = (&'static str, &'static [&'static str]);

// The keys serde reads for `T`, as its derive declares them (renames applied).
fn fields_of<'de, T: Deserialize<'de>>() -> &'static [&'static str] {
    struct Capture<'a>(&'a mut &'static [&'static str]);
    impl<'de> serde::Deserializer<'de> for Capture<'_> {
        type Error = serde::de::value::Error;
        fn deserialize_any<V: serde::de::Visitor<'de>>(
            self,
            _: V,
        ) -> Result<V::Value, Self::Error> {
            Err(serde::de::Error::custom("keys only"))
        }
        fn deserialize_struct<V: serde::de::Visitor<'de>>(
            self,
            _: &'static str,
            fields: &'static [&'static str],
            _: V,
        ) -> Result<V::Value, Self::Error> {
            *self.0 = fields;
            Err(serde::de::Error::custom("keys only"))
        }
        serde::forward_to_deserialize_any! {
            bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf
            option unit unit_struct newtype_struct seq tuple tuple_struct map enum identifier ignored_any
        }
    }
    let mut fields: &'static [&'static str] = &[];
    let _ = T::deserialize(Capture(&mut fields));
    fields
}

// Every block of the file by its path; "" is the top level. Each denies unknown keys.
fn blocks() -> [Block; 7] {
    [
        ("", fields_of::<CheckConfig>()),
        ("ios", fields_of::<IosConfig>()),
        ("ios.build", fields_of::<IosWorkspaceBuild>()),
        ("android", fields_of::<AndroidConfig>()),
        ("loginMarker", fields_of::<LoginMarker>()),
        ("build", fields_of::<BuildConfig>()),
        ("deadlines", fields_of::<Deadlines>()),
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Finding {
    // A key that reads as a key of exactly one other block.
    Moved {
        from: &'static str,
        home: &'static str,
        name: &'static str,
    },
    // A key that reads as a key of its own block, in another case or with other separators.
    Respelled {
        block: &'static str,
        name: &'static str,
    },
    Unknown {
        block: &'static str,
        index: usize,
        count: usize,
    },
    // The YAML reader itself stopped here, before any key was judged.
    NotYaml {
        line: usize,
        column: usize,
    },
}

fn squash(key: &str) -> String {
    key.chars()
        .filter(|c| !matches!(c, '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect()
}

fn walk(block: &'static str, map: &Mapping, blocks: &[Block], found: &mut Vec<Finding>) {
    let fields = blocks
        .iter()
        .find(|(path, _)| *path == block)
        .map_or(&[][..], |(_, fields)| *fields);
    for (index, (key, value)) in map.iter().enumerate() {
        let key = match key {
            Value::String(key) => Some(key.as_str()),
            _ => None,
        };
        if let Some(name) = fields.iter().copied().find(|field| key == Some(*field)) {
            let path = if block.is_empty() {
                name.to_string()
            } else {
                format!("{block}.{name}")
            };
            if let (Some((child, _)), Value::Mapping(inner)) =
                (blocks.iter().find(|(child, _)| *child == path), value)
            {
                walk(child, inner, blocks, found);
            }
            continue;
        }
        let squashed = key.map(squash);
        let reads_as = |field: &&'static str| squashed.as_deref() == Some(squash(field).as_str());
        if let Some(name) = fields.iter().copied().find(|field| reads_as(field)) {
            found.push(Finding::Respelled { block, name });
            continue;
        }
        let mut homes = blocks.iter().flat_map(|(home, fields)| {
            fields
                .iter()
                .copied()
                .filter(|field| reads_as(field))
                .map(|name| (*home, name))
        });
        found.push(match (homes.next(), homes.next()) {
            (Some((home, name)), None) => Finding::Moved {
                from: block,
                home,
                name,
            },
            _ => Finding::Unknown {
                block,
                index: index + 1,
                count: map.len(),
            },
        });
    }
}

// "`ios:` then `build:`": a nested block is two keys, never one key with a dot.
fn nest(block: &str) -> String {
    block
        .split('.')
        .map(|step| format!("`{step}:`"))
        .collect::<Vec<_>>()
        .join(" then ")
}

fn label(block: &str) -> String {
    if block.is_empty() {
        "the top level".to_string()
    } else {
        nest(block)
    }
}

fn place(block: &str) -> String {
    if block.is_empty() {
        "at the top level".to_string()
    } else {
        format!("under {}", nest(block))
    }
}

// What was found, as a fact about the file; how to edit it is the author's call.
fn state(finding: &Finding) -> String {
    match finding {
        Finding::Moved { from, home, name } => format!(
            "{} has a key for `{name}`, which is read only {}",
            label(from),
            place(home)
        ),
        Finding::Respelled { block, name } => {
            format!(
                "{} has a key for `{name}` in another spelling",
                label(block)
            )
        }
        Finding::Unknown {
            block,
            index,
            count,
        } => format!(
            "key {index} of {count} {} is not one qaren {} reads",
            place(block),
            crate::VERSION
        ),
        Finding::NotYaml { line, column } => {
            format!("the YAML reader stopped at line {line}, column {column}")
        }
    }
}

// Every key this build reads and where, for the one next step of a stated parse fault.
fn key_map(blocks: &[Block]) -> String {
    blocks
        .iter()
        .map(|(block, fields)| format!("{}: {}", place(block), fields.join(", ")))
        .collect::<Vec<_>>()
        .join("; ")
}

fn audit(raw: &str, blocks: &[Block]) -> Vec<Finding> {
    // Reading without judging any value fails only for YAML the reader cannot follow.
    if let Err(error) = serde_yaml::from_str::<IgnoredAny>(raw) {
        return error
            .location()
            .map(|at| Finding::NotYaml {
                line: at.line(),
                column: at.column(),
            })
            .into_iter()
            .collect();
    }
    // A tag lets the loader and this pass read one text differently (`!copy deadlines` is a second
    // `deadlines` to the loader), and a tag needs `!`: with one anywhere in the file, name no key.
    if raw.contains('!') {
        return Vec::new();
    }
    // A key written twice or a number too large for this read stops it: name nothing then.
    let Ok(Value::Mapping(root)) = serde_yaml::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    walk("", &root, blocks, &mut found);
    found
}

// None when no parse fault can be stated: the fault is then a value, a missing key, a key written
// twice, or a key fault in a file that contains `!`.
pub(super) fn name_faults(raw: &str) -> Option<Named> {
    let blocks = blocks();
    let found = audit(raw, &blocks);
    // Two keys can give the same fact (two spellings of one key): say it once.
    let mut seen_facts = std::collections::HashSet::new();
    let mut facts: Vec<String> = Vec::new();
    let mut more: usize = 0;
    for finding in &found {
        let fact = state(finding);
        if seen_facts.insert(fact.clone()) {
            if facts.len() < SPELLED_OUT {
                facts.push(fact);
            } else {
                more += 1;
            }
        }
    }
    if facts.is_empty() {
        return None;
    }
    if more == 1 {
        facts.push("1 more key fault remains".to_string());
    } else if more > 1 {
        facts.push(format!("{more} more key faults remain"));
    }
    Some(Named {
        seen: facts.join("; "),
        fix: format!(
            "correct what the detail identifies; this qaren reads, {}",
            key_map(&blocks)
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every stated key fault must be in a file the loader refuses.
    fn found(raw: &str) -> Vec<Finding> {
        let found = audit(raw, &blocks());
        if !found.is_empty() {
            assert!(
                serde_yaml::from_str::<CheckConfig>(raw).is_err(),
                "the loader accepts {raw:?}"
            );
        }
        found
    }

    fn named(raw: &str) -> Named {
        assert!(
            serde_yaml::from_str::<CheckConfig>(raw).is_err(),
            "the loader accepts {raw:?}"
        );
        name_faults(raw).unwrap()
    }

    #[test]
    fn the_block_table_lists_blocks_the_derives_read() {
        let blocks = blocks();
        for (path, fields) in blocks {
            assert!(!fields.is_empty(), "{path}");
            let Some((parent, key)) = path
                .rsplit_once('.')
                .or((!path.is_empty()).then_some(("", path)))
            else {
                continue;
            };
            let parent = blocks.iter().find(|(p, _)| *p == parent).unwrap().1;
            assert!(parent.contains(&key), "{path}");
        }
        assert_eq!(
            blocks[6].1,
            [
                "install_deps_seconds",
                "build_seconds",
                "device_boot_seconds",
                "manifest_warmup_seconds",
                "attach_seconds"
            ]
        );
        assert_eq!(
            key_map(&blocks),
            "at the top level: appId, video, packageManager, registryAuthEnv, metroPort, ios, android, nodePath, devClientScheme, loginBlock, loginMarker, savePlans, proofInDescription, depsCache, build, deadlines; under `ios:`: deviceType, runtime, build; under `ios:` then `build:`: workspace, scheme; under `android:`: avd; under `loginMarker:`: id, text; under `build:`: jobs, priority, arch; under `deadlines:`: install_deps_seconds, build_seconds, device_boot_seconds, manifest_warmup_seconds, attach_seconds"
        );
    }

    #[test]
    fn a_misplaced_or_respelled_attach_limit_is_stated_by_its_real_key() {
        let moved = |from| Finding::Moved {
            from,
            home: "deadlines",
            name: "attach_seconds",
        };
        for key in [
            "attach_seconds",
            "attachSeconds",
            "attach-seconds",
            "ATTACH_SECONDS",
        ] {
            assert_eq!(
                found(&format!("appId: a\n{key}: 300\n")),
                [moved("")],
                "{key}"
            );
            assert_eq!(
                found(&format!("appId: a\nios:\n  {key}: 300\n")),
                [moved("ios")]
            );
        }
        for key in ["attachSeconds", "attach-seconds", "Attach_Seconds"] {
            assert_eq!(
                found(&format!("appId: a\ndeadlines:\n  {key}: 300\n")),
                [Finding::Respelled {
                    block: "deadlines",
                    name: "attach_seconds"
                }],
                "{key}"
            );
        }
        assert_eq!(found("appId: a\ndeadlines:\n  attach_seconds: 300\n"), []);
    }

    // Each key gets its own fact; nothing here says which to keep or where to move one.
    #[test]
    fn keys_that_overlap_are_each_stated_as_they_are() {
        let respelled = Finding::Respelled {
            block: "deadlines",
            name: "attach_seconds",
        };
        let moved = Finding::Moved {
            from: "",
            home: "deadlines",
            name: "attach_seconds",
        };
        assert_eq!(
            found("appId: a\ndeadlines:\n  attach_seconds: 300\n  attachSeconds: 400\n"),
            [respelled]
        );
        assert_eq!(
            found("appId: a\nattach_seconds: 400\ndeadlines:\n  attach_seconds: 300\n"),
            [moved]
        );
        assert_eq!(
            found("appId: a\ndeadlines:\n  attachSeconds: 300\n  attach-seconds: 400\n"),
            [respelled, respelled]
        );
        // A respelled block is not looked into; the key beside it is still stated.
        assert_eq!(
            found("appId: a\nDeadlines: {attach_seconds: 300}\nattach_seconds: 400\n"),
            [
                Finding::Respelled {
                    block: "",
                    name: "deadlines"
                },
                moved
            ]
        );
        // The same fact is said once.
        let once = named("appId: a\ndeadlines:\n  attachSeconds: 300\n  attach-seconds: 400\n");
        assert_eq!(
            once.seen,
            "`deadlines:` has a key for `attach_seconds` in another spelling"
        );
    }

    #[test]
    fn a_key_fault_never_comes_with_an_edit_of_its_own() {
        let fix = format!(
            "correct what the detail identifies; this qaren reads, {}",
            key_map(&blocks())
        );
        for raw in [
            "appId: a\nattach_seconds: 300\n",
            "appId: a\ndeadlines:\n  attachSeconds: 300\n",
            "appId: a\nattachTimeout: 300\n",
            "appId: a\nios:\n  video: strict\n",
            "appId: a\nios:\n  deadlines: {video: strict, attach_seconds: 300}\n",
            "appId: a\nvideo: non-strict\nVideo: strict\n",
            "appId: a\nscheme: App\n",
        ] {
            let named = named(raw);
            assert_eq!(named.fix, fix, "{raw}");
            for word in ["remove", "keep one", "strict", "App"] {
                assert!(!named.seen.contains(word), "{raw}: {}", named.seen);
            }
        }
        assert!(!fix.contains("remove") && !fix.contains("keep one"));
    }

    #[test]
    fn other_key_faults_are_counted_not_quoted() {
        assert_eq!(
            found("appId: a\nattachTimeout: 300\n"),
            [Finding::Unknown {
                block: "",
                index: 2,
                count: 2
            }]
        );
        assert_eq!(
            found("appId: a\ndeadlines:\n  build_seconds: 60\n  attach: 300\n"),
            [Finding::Unknown {
                block: "deadlines",
                index: 2,
                count: 2
            }]
        );
        // `build` is read at the top level and under `ios:`: under `android:` it has no single home,
        // and in a block that reads it another spelling is a respelling.
        assert_eq!(
            found("appId: a\nandroid:\n  build: {}\n"),
            [Finding::Unknown {
                block: "android",
                index: 1,
                count: 1
            }]
        );
        assert_eq!(
            found("appId: a\nBUILD: {}\n"),
            [Finding::Respelled {
                block: "",
                name: "build"
            }]
        );
        assert_eq!(
            found("app_id: a\n"),
            [Finding::Respelled {
                block: "",
                name: "appId"
            }]
        );
        assert_eq!(
            found("appId: a\nios:\n  jobs: 2\n"),
            [Finding::Moved {
                from: "ios",
                home: "build",
                name: "jobs"
            }]
        );
        // Keys that are not strings, and YAML's merge key, are keys no block reads.
        for raw in ["appId: a\n1: b\n", "appId: a\n~: b\n", "appId: a\n[x]: b\n"] {
            assert_eq!(found(raw).len(), 1, "{raw}");
        }
        assert_eq!(
            found("appId: a\nbuild: &b {jobs: 2}\ndeadlines:\n  <<: *b\n"),
            [Finding::Unknown {
                block: "deadlines",
                index: 1,
                count: 1
            }]
        );
        // A nested place is written as two keys.
        assert_eq!(
            named("appId: a\nscheme: App\n").seen,
            "the top level has a key for `scheme`, which is read only under `ios:` then `build:`"
        );
    }

    #[test]
    fn anchors_and_aliases_are_read_as_the_loader_reads_them() {
        // Files with anchors and aliases that load state nothing.
        for raw in [
            "appId: a\ndevClientScheme: s\ndeadlines: &d {attach_seconds: 300}\n",
            "appId: &id a\ndevClientScheme: *id\n",
            "appId: a\ndevClientScheme: s\nnodePath: &k /usr/bin/node\ndeadlines:\n  build_seconds: &n 60\n  attach_seconds: *n\n",
            "appId: a\ndevClientScheme: &k deadlines\n*k : {attach_seconds: 300}\n",
        ] {
            assert!(serde_yaml::from_str::<CheckConfig>(raw).is_ok(), "{raw}");
            assert_eq!(found(raw), [], "{raw}");
        }
        // A block reached through an alias has the keys of the block it points to; the fact is
        // about the block that cannot read them.
        assert_eq!(
            found("appId: a\nbuild: &b {jobs: 2}\nios: *b\n"),
            [Finding::Moved {
                from: "ios",
                home: "build",
                name: "jobs"
            }]
        );
        assert_eq!(
            found("appId: a\nios: &lane {deviceType: x}\nandroid: *lane\n"),
            [Finding::Moved {
                from: "android",
                home: "ios",
                name: "deviceType"
            }]
        );
    }

    // With a tag in the file the loader and this pass can read one text differently
    // (`!copy deadlines` is a second `deadlines` to the loader): no key is stated, and since a tag
    // needs `!`, none is stated for any file that contains one, even inside a text value.
    #[test]
    fn a_file_with_an_exclamation_mark_states_no_key() {
        for raw in [
            "appId: a\ndeadlines: {attach_seconds: 300}\n!copy deadlines: {attach_seconds: 300}\n",
            "appId: a\ndeadlines:\n  attach_seconds: 300\n  !copy attach_seconds: 300\n",
            "appId: a\ndeadlines:\n  !!str attach_seconds: 300\n  attachSeconds: 400\n",
            "appId: a\n!!null deadlines: {}\nattach_seconds: 300\n",
            "appId: a\nattach_seconds: !!str 300\n",
            "appId: a\ndeadlines: !limits {attachSeconds: 300}\n",
            "appId: a\nregistryAuthEnv: [!x A]\nattach_seconds: 300\n",
            "appId: a\nloginBlock: b\nloginMarker: { text: \"Welcome!\" }\nattach_seconds: 300\n",
            "appId: a\nattach_seconds: 300 # five minutes!\n",
        ] {
            assert!(name_faults(raw).is_none(), "{raw:?}");
        }
    }

    #[test]
    fn only_the_reader_stopping_is_given_by_position() {
        for (raw, line, column) in [
            ("appId: a\ndeadlines:\n\tattach_seconds: 300\n", 3, 1),
            ("appId: [private-canary\n", 2, 1),
            ("appId: \"private-canary\n", 2, 1),
            // The reader's own stop is the same with or without a tag mark in the file.
            ("appId: [private-canary!\n", 2, 1),
        ] {
            assert_eq!(found(raw), [Finding::NotYaml { line, column }], "{raw:?}");
        }
        let stop = named("appId: [private-canary\n");
        assert_eq!(stop.seen, "the YAML reader stopped at line 2, column 1");
        assert_eq!(
            stop.fix,
            format!(
                "correct what the detail identifies; this qaren reads, {}",
                key_map(&blocks())
            )
        );
    }

    #[test]
    fn faults_this_pass_cannot_pin_down_state_nothing() {
        for raw in [
            "",
            "\n",
            "- a\n",
            "appId: a\n---\nappId: b\n",
            "appId: a\nvideo: private-canary\n",
            "appId: a\ndeadlines: 30\n",
            "appId: a\ndeadlines:\n",
            "appId: a\nmetroPort: abc\n",
            "appId: a\ndeadlines:\n  attach_seconds: \"300\"\n",
            // A key written twice, or a number too large for the second read, stops that read,
            // also when another key of the file is misplaced.
            "appId: a\ndeadlines:\n  attach_seconds: 300\n  attach_seconds: 300\n",
            "appId: a\ndeadlines:\n  attach_seconds: 18446744073709551616\n",
            "appId: 18446744073709551616\nattach_seconds: 300\n",
        ] {
            assert!(name_faults(raw).is_none(), "{raw:?}");
        }
    }

    #[test]
    fn more_than_three_different_faults_are_counted() {
        let four = named("appId: a\na1: 1\na2: 2\na3: 3\na4: 4\n");
        assert_eq!(
            four.seen,
            format!(
                "key 2 of 5 at the top level is not one qaren {v} reads; key 3 of 5 at the top level is not one qaren {v} reads; key 4 of 5 at the top level is not one qaren {v} reads; 1 more key fault remains",
                v = crate::VERSION
            )
        );
        // A repeated statement is not counted again among the remaining faults.
        let deduped = named(
            "appId: a\ndeadlines:\n  attachSeconds: 1\n  attach-seconds: 2\na1: 1\na2: 2\na3: 3\n",
        );
        assert_eq!(
            deduped.seen,
            format!(
                "`deadlines:` has a key for `attach_seconds` in another spelling; key 3 of 5 at the top level is not one qaren {v} reads; key 4 of 5 at the top level is not one qaren {v} reads; 1 more key fault remains",
                v = crate::VERSION
            )
        );
        let five = named("appId: a\na1: 1\na2: 2\na3: 3\na4: 4\na5: 5\n");
        assert_eq!(
            five.seen,
            format!(
                "key 2 of 6 at the top level is not one qaren {v} reads; key 3 of 6 at the top level is not one qaren {v} reads; key 4 of 6 at the top level is not one qaren {v} reads; 2 more key faults remain",
                v = crate::VERSION
            )
        );
    }
}
