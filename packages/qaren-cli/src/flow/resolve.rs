use crate::flow::plan::{Selector, Target};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

const NEAR_MISSES: usize = 6;
const INPUT_TYPES: [&str; 8] = [
    "TextField",
    "SecureTextField",
    "TextView",
    "SearchField",
    "EditText",
    "AutoCompleteTextView",
    "MultiAutoCompleteTextView",
    "TextInputEditText",
];

#[derive(Clone, PartialEq)]
pub struct Node {
    pub index: usize,
    pub parent: Option<usize>,
    pub kind: String,
    pub label: String,
    pub identifier: String,
    pub value: String,
    pub secure: bool,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Node {
    // A runner snapshot node: identity and geometry are required, text fields default to empty.
    pub fn from_json(value: &Value) -> Result<Node, String> {
        let index = value["index"]
            .as_u64()
            .and_then(|i| usize::try_from(i).ok())
            .ok_or("a node has no index")?;
        let rect = |key: &str| {
            value["rect"][key]
                .as_f64()
                .filter(|n| n.is_finite())
                .ok_or(format!("node {index} has no rect.{key}"))
        };
        let text = |key: &str| value[key].as_str().unwrap_or_default().to_string();
        Ok(Node {
            index,
            parent: value["parentIndex"].as_u64().map(|p| p as usize),
            kind: text("type"),
            label: text("label"),
            identifier: text("identifier"),
            value: text("value"),
            secure: value["secure"].as_bool() == Some(true),
            x: rect("x")?,
            y: rect("y")?,
            width: rect("width")?,
            height: rect("height")?,
        })
    }

    pub fn center(&self) -> (f64, f64) {
        (self.x + self.width / 2.0, self.y + self.height / 2.0)
    }

    fn is_input(&self) -> bool {
        self.secure || INPUT_TYPES.iter().any(|t| self.kind.ends_with(t))
    }

    // Diagnostics never carry a value, and an input's label may be what the user typed. The
    // text stays raw here; the trace boundary masks, redacts and bounds it.
    pub fn describe(&self) -> String {
        let label = if self.is_input() {
            "[input]".to_string()
        } else {
            format!("{:?}", self.label)
        };
        format!(
            "{}[label={label} id={:?} rect={},{},{}x{}]",
            self.kind, self.identifier, self.x, self.y, self.width, self.height
        )
    }
}

impl std::fmt::Debug for Node {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.describe())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub nodes: Vec<Node>,
    // A truncated tree can prove presence, never absence.
    pub truncated: bool,
}

impl Snapshot {
    // Refuses a tree that could not carry evidence: no nodes, a zero viewport, repeated indices.
    pub fn from_data(data: &Value) -> Result<Snapshot, String> {
        let nodes = data["nodes"]
            .as_array()
            .ok_or("snapshot has no nodes array")?
            .iter()
            .map(Node::from_json)
            .collect::<Result<Vec<Node>, String>>()?;
        let screen = nodes.first().ok_or("snapshot has no nodes")?;
        if screen.width <= 0.0 || screen.height <= 0.0 {
            return Err("snapshot has no viewport".into());
        }
        let mut seen = HashSet::new();
        if let Some(repeated) = nodes.iter().find(|n| !seen.insert(n.index)) {
            return Err(format!("snapshot repeats node index {}", repeated.index));
        }
        Ok(Snapshot {
            nodes,
            truncated: data["truncated"].as_bool() == Some(true),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Resolution {
    Found(Node),
    NotFound { near_misses: Vec<String> },
    Ambiguous { candidates: Vec<String> },
    OutOfRange { index: usize, matches: Vec<String> },
}

// Exact identifier for id, exact trimmed equality over label then value for text, centre on screen.
fn matches(selector: &Selector, node: &Node, screen: &Node) -> bool {
    let hit = match &selector.target {
        Target::Id(id) => node.identifier == *id,
        Target::Text(text) => {
            let text = text.trim();
            !text.is_empty() && (node.label.trim() == text || node.value.trim() == text)
        }
    };
    let (cx, cy) = node.center();
    hit && node.width > 0.0
        && node.height > 0.0
        && cx >= screen.x
        && cx <= screen.x + screen.width
        && cy >= screen.y
        && cy <= screen.y + screen.height
}

// Rule C: every on-screen match in document order, each mapped to its deepest matching
// descendant with duplicates kept, so `index` counts the positions the author saw.
pub fn match_list<'a>(selector: &Selector, nodes: &'a [Node]) -> Vec<&'a Node> {
    let Some(screen) = nodes.first() else {
        return Vec::new();
    };
    let hits: Vec<&Node> = nodes
        .iter()
        .filter(|n| matches(selector, n, screen))
        .collect();
    let by_index: HashMap<usize, &Node> = nodes.iter().map(|n| (n.index, n)).collect();
    // Hops to the root, stopping at a parent cycle so a malformed snapshot cannot hang the resolver.
    let ancestors = |node: &Node| -> Vec<usize> {
        let mut chain = Vec::new();
        let mut parent = node.parent;
        while let Some(index) = parent {
            if chain.len() > nodes.len() {
                break;
            }
            chain.push(index);
            parent = by_index.get(&index).and_then(|n| n.parent);
        }
        chain
    };
    let descends = |node: &Node, ancestor: &Node| ancestors(node).contains(&ancestor.index);
    let leaves: Vec<&Node> = hits
        .iter()
        .copied()
        .filter(|a| !hits.iter().any(|h| descends(h, a)))
        .collect();
    hits.iter()
        .map(|hit| {
            let mut deepest: Option<(usize, &Node)> = None;
            for leaf in leaves
                .iter()
                .copied()
                .filter(|leaf| leaf.index == hit.index || descends(leaf, hit))
            {
                let depth = ancestors(leaf).len();
                if deepest.is_none_or(|(best, _)| depth >= best) {
                    deepest = Some((depth, leaf));
                }
            }
            deepest.map_or(*hit, |(_, leaf)| leaf)
        })
        .collect()
}

pub fn resolve(selector: &Selector, nodes: &[Node]) -> Resolution {
    let list = match_list(selector, nodes);
    let describe = |list: &[&Node]| list.iter().map(|n| n.describe()).collect::<Vec<_>>();
    if list.is_empty() {
        return Resolution::NotFound {
            near_misses: near_misses(selector, nodes),
        };
    }
    match selector.index {
        Some(index) => match list.get(index) {
            Some(node) => Resolution::Found((*node).clone()),
            None => Resolution::OutOfRange {
                index,
                matches: describe(&list),
            },
        },
        None => {
            let mut distinct: Vec<&Node> = Vec::new();
            for node in &list {
                if !distinct.iter().any(|d| d.index == node.index) {
                    distinct.push(node);
                }
            }
            if distinct.len() > 1 {
                Resolution::Ambiguous {
                    candidates: describe(&distinct),
                }
            } else {
                Resolution::Found(list[0].clone())
            }
        }
    }
}

pub fn near_misses(selector: &Selector, nodes: &[Node]) -> Vec<String> {
    let needle = match &selector.target {
        Target::Id(id) => id.to_lowercase(),
        Target::Text(text) => text.trim().to_lowercase(),
    };
    if needle.is_empty() {
        return Vec::new();
    }
    nodes
        .iter()
        .filter(|n| {
            [&n.label, &n.identifier, &n.value]
                .iter()
                .any(|field| field.to_lowercase().contains(&needle))
        })
        .take(NEAR_MISSES)
        .map(Node::describe)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn node(index: usize, parent: Option<usize>, kind: &str, label: &str) -> Node {
        Node {
            index,
            parent,
            kind: kind.into(),
            label: label.into(),
            identifier: String::new(),
            value: String::new(),
            secure: false,
            x: 0.0,
            y: 0.0,
            width: 400.0,
            height: 40.0,
        }
    }

    fn screen() -> Node {
        Node {
            height: 874.0,
            ..node(0, None, "Application", "")
        }
    }

    fn text(label: &str, index: Option<usize>) -> Selector {
        Selector {
            target: Target::Text(label.into()),
            index,
        }
    }

    fn id(id: &str) -> Selector {
        Selector {
            target: Target::Id(id.into()),
            index: None,
        }
    }

    #[test]
    fn index_selects_the_nth_on_screen_match() {
        let at = |index, y| Node {
            y,
            ..node(index, Some(0), "Other", "Get Started")
        };
        let nodes = vec![screen(), at(1, 0.0), at(2, 700.0), at(3, 900.0)];
        match resolve(&text("Get Started", Some(1)), &nodes) {
            Resolution::Found(found) => assert_eq!(found.y, 700.0),
            other => panic!("{other:?}"),
        }
        assert!(
            matches!(
                resolve(&text("Get Started", Some(2)), &nodes),
                Resolution::OutOfRange { .. }
            ),
            "an off-screen match does not count"
        );
    }

    #[test]
    fn ancestor_matches_yield_to_the_deepest() {
        let nodes = vec![
            screen(),
            node(6, Some(0), "Other", "Tasks"),
            node(7, Some(6), "NavigationBar", "Tasks"),
            node(8, Some(7), "Button", "Tasks"),
        ];
        match resolve(&text("Tasks", None), &nodes) {
            Resolution::Found(found) => assert_eq!(found.kind, "Button"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn index_counts_a_labelled_container_that_maps_to_its_button() {
        let nodes = vec![
            screen(),
            Node {
                height: 874.0,
                ..node(1, Some(0), "Other", "Get Started")
            },
            Node {
                y: 783.0,
                ..node(2, Some(1), "Other", "Get Started")
            },
        ];
        for index in [Some(1), Some(0), None] {
            match resolve(&text("Get Started", index), &nodes) {
                Resolution::Found(found) => assert_eq!(found.index, 2, "{index:?}"),
                other => panic!("{index:?}: {other:?}"),
            }
        }
    }

    #[test]
    fn the_deepest_descendant_wins_over_a_later_shallower_one() {
        let nodes = vec![
            screen(),
            node(1, Some(0), "Other", "Save"),
            node(2, Some(1), "Other", "Save"),
            Node {
                y: 100.0,
                ..node(3, Some(2), "Button", "Save")
            },
            Node {
                y: 200.0,
                ..node(4, Some(1), "StaticText", "Save")
            },
        ];
        let list = match_list(&text("Save", None), &nodes);
        assert_eq!(list[0].index, 3, "the container maps to its deepest match");
        assert_eq!(list.len(), 4);
        assert!(matches!(
            resolve(&text("Save", None), &nodes),
            Resolution::Ambiguous { .. }
        ));
    }

    #[test]
    fn distinct_matches_without_an_index_refuse_as_ambiguous() {
        let nodes = vec![
            screen(),
            node(1, Some(0), "StaticText", "Save"),
            Node {
                y: 500.0,
                ..node(2, Some(0), "Button", "Save")
            },
        ];
        match resolve(&text("Save", None), &nodes) {
            Resolution::Ambiguous { candidates } => {
                assert_eq!(candidates.len(), 2);
                assert!(candidates[0].starts_with("StaticText"));
                assert!(candidates[1].starts_with("Button"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_index_past_the_list_fails_and_names_the_list() {
        let nodes = vec![screen(), node(1, Some(0), "Button", "Save")];
        match resolve(&text("Save", Some(3)), &nodes) {
            Resolution::OutOfRange { index, matches } => {
                assert_eq!(index, 3);
                assert_eq!(matches.len(), 1);
                assert!(matches[0].contains("Button"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn id_is_exact_text_is_trimmed_equality_and_a_miss_names_near_misses() {
        let nodes = vec![
            screen(),
            Node {
                identifier: "save-button".into(),
                ..node(1, Some(0), "Button", "  Save  ")
            },
        ];
        assert!(matches!(
            resolve(&id("save-button"), &nodes),
            Resolution::Found(_)
        ));
        assert!(matches!(
            resolve(&text("Save", None), &nodes),
            Resolution::Found(_)
        ));
        match resolve(&id("save"), &nodes) {
            Resolution::NotFound { near_misses } => {
                assert_eq!(near_misses.len(), 1);
                assert!(near_misses[0].contains("save-button"));
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            resolve(&text("Sav", None), &nodes),
            Resolution::NotFound { .. }
        ));
    }

    #[test]
    fn blank_text_never_matches_an_empty_label() {
        let nodes = vec![screen(), node(1, Some(0), "Other", "")];
        match resolve(&text("   ", None), &nodes) {
            Resolution::NotFound { near_misses } => assert!(near_misses.is_empty()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn diagnostics_and_debug_never_carry_values_or_input_labels() {
        let input = Node {
            value: "hunter2".into(),
            identifier: "password".into(),
            ..node(1, Some(0), "XCUIElementTypeSecureTextField", "hunter2")
        };
        let described = input.describe();
        assert!(!described.contains("hunter2"), "{described}");
        assert!(described.contains("[input]") && described.contains("password"));
        assert!(!format!("{input:?}").contains("hunter2"));
        let edit = node(2, None, "android.widget.EditText", "typed here");
        assert!(!edit.describe().contains("typed"));
        let button = Node {
            value: "secret".into(),
            ..node(3, Some(0), "Button", "Save")
        };
        assert!(button.describe().contains("\"Save\""));
        assert!(!format!("{button:?}").contains("secret"));
    }

    #[test]
    fn describe_keeps_raw_text_for_the_trace_boundary() {
        let long = format!(
            "Save ghp_abcdefghijklmnopqrstuvwxyz123456 {}",
            "x".repeat(200)
        );
        let mut first = node(1, Some(0), "Button", &long);
        first.identifier = "target".into();
        assert_eq!(
            first.describe(),
            format!("Button[label={long:?} id=\"target\" rect=0,0,400x40]")
        );
        match resolve(&id("Save"), &[screen(), first]) {
            Resolution::NotFound { near_misses } => assert!(near_misses[0].contains(&long)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_snapshot_keeps_truncation_and_refuses_trees_without_evidence() {
        let root = json!({"index": 0, "type": "Application", "rect": {"x": 0, "y": 0, "width": 400, "height": 800}});
        let data = json!({"nodes": [root], "truncated": true});
        let snapshot = Snapshot::from_data(&data).unwrap();
        assert!(snapshot.truncated);
        assert_eq!(snapshot.nodes[0].width, 400.0);
        let refused = [
            json!({}),
            json!({"nodes": []}),
            json!({"nodes": [{}]}),
            json!({"nodes": [{"index": 0, "rect": {"x": 0, "y": 0, "width": 0, "height": 0}}]}),
            json!({"nodes": [{"index": 0, "rect": {"x": 0, "y": 0, "width": 400}}]}),
            json!({"nodes": [root, {"index": 0, "rect": {"x": 0, "y": 0, "width": 1, "height": 1}}]}),
            json!({"nodes": [root, {"rect": {"x": 0, "y": 0, "width": 1, "height": 1}}]}),
        ];
        for data in refused {
            assert!(Snapshot::from_data(&data).is_err(), "{data}");
        }
    }
}
