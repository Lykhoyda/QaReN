import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { provenanceDiagnosticFromWire } from '../../../dist/qa/label-provenance.js';
import { assertProvenanceAdmission } from '../../helpers/candidate-provenance.ts';

const runner = fileURLToPath(new URL('../../../../rn-android-runner/', import.meta.url));
const kotlin = join(
  runner,
  'app/src/androidTest/java/dev/lykhoyda/rndevagent/androidrunner/CommandDispatcher.kt',
);

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start),
    to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

test('Android producer emits clean timeout only between complete checked samples', async () => {
  const source = readFileSync(kotlin, 'utf8');
  const rules = readFileSync(
    join(runner, 'app/src/main/java/dev/lykhoyda/rndevagent/androidrunner/PresenceRules.kt'),
    'utf8',
  );
  const scratch = mkdtempSync(join(runner, '.candidate-producer-'));
  try {
    mkdirSync(join(scratch, 'src/main/kotlin'), { recursive: true });
    writeFileSync(
      join(scratch, 'settings.gradle.kts'),
      'rootProject.name = "candidate-producer"\n',
    );
    writeFileSync(
      join(scratch, 'build.gradle.kts'),
      `
plugins { kotlin("jvm") version "2.0.21"; application }
repositories { mavenCentral() }
application { mainClass.set("HarnessKt") }
kotlin { jvmToolchain(17) }
`,
    );
    writeFileSync(
      join(scratch, 'src/main/kotlin/Harness.kt'),
      `
object SystemClock {
  var now = 0L
  fun uptimeMillis() = now
  fun sleep(ms: Long) { now += ms }
}
object Build { object VERSION { const val SDK_INT = 33 } }
class AccessibilityNodeInfo { fun recycle() {} }
class JSONArray(initial: List<Any?> = emptyList()) {
  val values = initial.toMutableList()
  fun put(value: Any?): JSONArray { values.add(value); return this }
  fun length() = values.size
  fun optInt(index: Int, fallback: Int) = values.getOrNull(index) as? Int ?: fallback
}
class JSONObject {
  companion object { val NULL: Any? = null }
  val values = mutableMapOf<String, Any?>()
  fun put(key: String, value: Any?): JSONObject { values[key] = value; return this }
  fun remove(key: String) = values.remove(key)
  fun optInt(key: String, fallback: Int = 0) = values[key] as? Int ?: fallback
  fun getInt(key: String) = values[key] as Int
  fun optBoolean(key: String) = values[key] as? Boolean ?: false
  fun optString(key: String) = values[key] as? String ?: ""
  fun optJSONArray(key: String) = values[key] as? JSONArray
  fun optJSONObject(key: String) = values[key] as? JSONObject
}
object QaHierarchy {
  data class QaNode(val type: String, val identifier: String = "", val label: String = "Add coverage",
    val rect: Int = 1, val enabled: Boolean = true, val depth: Int = 0, val parentIndex: Int? = null,
    val selected: Boolean = false, val secure: Boolean = false, val editable: Boolean = false,
    val visibleToUser: Boolean = true, val clickable: Boolean = false, val source: Any? = null)
  data class Assembled(val nodes: List<QaNode>, val eligible: Boolean = true, val truncated: Boolean = false)
}
typealias QaNode = QaHierarchy.QaNode
object PresenceRules {
${rules.slice(rules.indexOf('    fun sameEvidence('), rules.lastIndexOf('}'))}
}
class Harness(val mode: String) {
  val qaSnapshotGeneration = 7
  val qaSnapshotNodes = listOf(QaNode("Other"), QaNode("Button", parentIndex = 0, depth = 1))
  var enumerations = 0
  data class Enumeration(val windows: List<Int>, val assembled: QaHierarchy.Assembled, val exhausted: Boolean)
  fun enumerateQa(app: String, handles: MutableList<AccessibilityNodeInfo>): Enumeration? {
    enumerations++
    if (enumerations == 2 && mode == "root") { SystemClock.now += 500; return null }
    val partial = enumerations == 2 && mode == "partial"
    if (partial) SystemClock.now += 500
    val nodes = if (enumerations == 2 && mode == "identity") qaSnapshotNodes.mapIndexed { index, node ->
      if (index == 0) node.copy(rect = 2) else node
    } else qaSnapshotNodes
    return Enumeration(emptyList(), QaHierarchy.Assembled(nodes, truncated = partial), partial)
  }
  inner class PresencePass(app: String, generation: Int, started: Long, budget: Int,
    windows: List<Int>, assembled: QaHierarchy.Assembled, exhausted: Boolean, indices: Set<Int>) {
    var expired = false
    fun run(): PresencePass {
      if (enumerations == 2 && mode == "live-timeout") { SystemClock.now += 500; expired = true }
      return this
    }
    fun node(index: Int): JSONObject = JSONObject().put("status", if (expired) "unknown" else "observed")
      .put("labelSource", if (index == 1 || mode == "direct" || (enumerations == 2 && mode == "source")) "direct" else "descendant")
    fun capture() = JSONObject().put("diagnostics", JSONObject().put("failure", JSONObject().put("reason", "deadline")))
  }
${section(source, '    private fun qaLabelProvenance(', '    // presenceBudgetMs:')}
  fun run(): JSONObject {
    val command = JSONObject().put("labelProvenance", JSONArray(listOf(0, 1)))
      .put("platformPresence", true).put("snapshotGeneration", 7)
      .put("presenceBudgetMs", if (mode == "clean" || mode == "direct") 100 else 300)
    return qaLabelProvenance("test", command)
  }
}
fun json(value: Any?): String = when(value) {
  null -> "null"
  is JSONObject -> value.values.entries.joinToString(",", "{", "}") { "\\\"" + it.key + "\\\":" + json(it.value) }
  is JSONArray -> value.values.joinToString(",", "[", "]") { json(it) }
  is String -> "\\\"" + value + "\\\""
  else -> value.toString()
}
fun main() {
  SystemClock.now = 0
  val available = Harness("available").run()
  check(available.optJSONObject("labelProvenanceDiagnostics")!!.optString("outcome") == "available")
  check(available.optJSONArray("labelProvenance")!!.length() == 2)
  for (mode in listOf("clean", "direct", "source", "identity", "partial", "root", "live-timeout")) {
    SystemClock.now = 0
    val result = Harness(mode).run()
    check(!result.values.containsKey("labelProvenance"))
    val diagnostic = result.optJSONObject("labelProvenanceDiagnostics")!!
    check((diagnostic.optString("outcome") == "deadline-clean") == (mode == "clean"))
    println(json(JSONObject().put("name", mode).put("diagnostic", diagnostic)))
  }
}
`,
    );
    const result = spawnSync(
      join(runner, 'gradlew'),
      ['--project-dir', scratch, '--console=plain', '--quiet', 'run', '--no-daemon'],
      {
        encoding: 'utf8',
        timeout: 240_000,
        maxBuffer: 2_000_000,
      },
    );
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const rows = result.stdout
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 7);
    for (const row of rows)
      await assertProvenanceAdmission(
        provenanceDiagnosticFromWire(row.diagnostic),
        row.name === 'clean',
      );
    for (const outcome of ['deadline', 'unknown-timeout'])
      await assertProvenanceAdmission(
        provenanceDiagnosticFromWire({
          outcome,
          fieldMask: 0,
          sampleCount: 1,
          nodeIndex: null,
          directLabelIndices: [1],
          deadlineExpired: true,
        }),
        false,
      );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
