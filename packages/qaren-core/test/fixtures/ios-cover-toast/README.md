# iOS covering-toast regression inputs

These `join()` inputs come from a persistent-toast run of the Test App at
`b35c3973149c4ffbd1bdd1bbd092ced27ee8ec69`, using QaReN at
`9b07d887960b35a709e2ca371dad9775bc6afa4f` on iOS 26.5.

`before-scroll`, `after-scroll` and `presence` retain observations 21, 25 and 27.
Unrelated React hosts and digest entries were removed, host indexes were
compacted consistently, and redundant native acquisition stamps were removed.
The retained native nodes, frames, states and ancestry are unchanged. In
particular, the native toast and Close are siblings; their matched React hosts
prove that Close belongs to the toast.

The test adds the capture admission and keyboard annotations recorded by the
run, then executes the normal walker with the captured screens. Disabled and
sibling-control cases are explicit mutations of the captured input.
