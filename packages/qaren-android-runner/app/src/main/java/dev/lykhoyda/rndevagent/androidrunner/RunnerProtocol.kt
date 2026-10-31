/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

// GH #383: /command wire-protocol version. Must stay in sync with
// packages/rn-dev-agent-core/src/runners/protocol.ts and RunnerProtocol.swift —
// enforced by cdp-bridge test/unit/gh-383-protocol-sync.test.js.
object RunnerProtocol {
    const val VERSION = 2
}
