/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
package dev.lykhoyda.rndevagent.androidrunner

import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.Bounds
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.RawNode
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.RawWindow
import dev.lykhoyda.rndevagent.androidrunner.QaHierarchy.WindowKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class QaHierarchyTest {
    private val app = "com.example.app"
    private val display = Bounds(0, 0, 1080, 2400)
    private val full = Bounds(0, 0, 1080, 2400)

    @Test fun rootsComeFirstAndAncestryFollowsNesting() {
        val tree = node("A", children = listOf(node("B", children = listOf(node("C"))), node("D")))
        val out = QaHierarchy.assemble(listOf(appWindow(tree)), app, display)

        assertEquals(listOf("Application", "Window", "A", "B", "C", "D"), out.nodes.map { it.type })
        assertEquals(listOf(0, 1, 2, 3, 4, 5), out.nodes.map { it.index })
        assertEquals(listOf(0, 1, 2, 3, 4, 3), out.nodes.map { it.depth })
        assertEquals(listOf(null, 0, 1, 2, 3, 2), out.nodes.map { it.parentIndex })
        assertEquals(display, out.nodes[0].rect)
        assertEquals(full, out.nodes[1].rect)
        assertEquals(0, out.droppedNodes)
        assertFalse(out.truncated)
        assertFalse(out.keyboardVisible)
        assertTrue(out.eligible)
    }

    @Test fun aDroppedNodeIsCountedAndItsChildrenKeepConsistentAncestry() {
        val tree = node(
            "A",
            children = listOf(
                node("B", bounds = null, children = listOf(node("C"))),
                null,
                node("D"),
            ),
        )
        val out = QaHierarchy.assemble(listOf(appWindow(tree)), app, display)

        assertEquals(listOf("Application", "Window", "A", "C", "D"), out.nodes.map { it.type })
        assertEquals(listOf(null, 0, 1, 2, 2), out.nodes.map { it.parentIndex })
        assertEquals(listOf(0, 1, 2, 3, 3), out.nodes.map { it.depth })
        assertEquals(2, out.droppedNodes)
    }

    @Test fun aVisibleNodeWithAnInvertedRectIsDroppedButAnEmptyClippedRectIsKept() {
        val tree = node(
            "A",
            children = listOf(
                node("Inverted", bounds = Bounds(10, 10, 5, 20)),
                node("Clipped", bounds = Bounds(0, 2400, 1080, 2400), visibleToUser = false),
            ),
        )
        val out = QaHierarchy.assemble(listOf(appWindow(tree)), app, display)

        assertEquals(listOf("Application", "Window", "A", "Clipped"), out.nodes.map { it.type })
        assertEquals(1, out.droppedNodes)
    }

    // A pager page scrolled out to the right: Android clips the right edge to the
    // viewport but keeps the true left, so the reported rect is inverted.
    @Test fun aScrolledOutNodeWithAnInvertedClippedRectIsKeptEmptyAtItsOrigin() {
        val page = node(
            "Page",
            bounds = Bounds(2160, 0, 1080, 2089),
            visibleToUser = false,
            children = listOf(node("Title", bounds = Bounds(2625, 1136, 1080, 1210), visibleToUser = false)),
        )
        val pager = node("Pager", bounds = Bounds(0, 0, 1080, 2089), children = listOf(node("Shown"), page))
        val out = QaHierarchy.assemble(listOf(appWindow(pager)), app, display)

        assertEquals(listOf("Application", "Window", "Pager", "Shown", "Page", "Title"), out.nodes.map { it.type })
        assertEquals(listOf(null, 0, 1, 2, 2, 4), out.nodes.map { it.parentIndex })
        assertEquals(Bounds(2160, 0, 2160, 2089), out.nodes[4].rect)
        assertEquals(Bounds(2625, 1136, 2625, 1210), out.nodes[5].rect)
        assertEquals(listOf(false, false), out.nodes.drop(4).map { it.visibleToUser })
        assertEquals(listOf(false, false), out.nodes.drop(4).map { it.hittable })
        assertEquals(0, out.droppedNodes)
    }

    @Test fun aWindowWhoseRootIsUnreadableCountsAsDropped() {
        val out = QaHierarchy.assemble(listOf(appWindow(null)), app, display)

        assertEquals(listOf("Application", "Window"), out.nodes.map { it.type })
        assertEquals(1, out.droppedNodes)
    }

    @Test fun twoAppWindowsAreEmittedBottomToTopInLayerOrder() {
        val modal = appWindow(node("ModalContent"), id = 2, layer = 9, bounds = Bounds(100, 600, 980, 1800))
        val screen = appWindow(node("ScreenContent"), id = 1, layer = 3)
        val out = QaHierarchy.assemble(listOf(modal, screen), app, display)

        assertEquals(
            listOf("Application", "Window", "ScreenContent", "Window", "ModalContent"),
            out.nodes.map { it.type },
        )
        assertEquals(listOf(null, 0, 1, 0, 3), out.nodes.map { it.parentIndex })
        assertEquals(Bounds(100, 600, 980, 1800), out.nodes[3].rect)
        assertFalse(out.eligible)
    }

    @Test fun anInputMethodWindowBecomesOneKeyboardChildOfApplication() {
        val imeBounds = Bounds(0, 1500, 1080, 2400)
        val ime = RawWindow(7, WindowKind.INPUT_METHOD, 20, "com.example.ime", imeBounds, node("Key"))
        val out = QaHierarchy.assemble(listOf(appWindow(node("A")), ime), app, display)

        assertEquals(listOf("Application", "Window", "A", "Keyboard"), out.nodes.map { it.type })
        val keyboard = out.nodes.last()
        assertEquals(imeBounds, keyboard.rect)
        assertEquals(0, keyboard.parentIndex)
        assertEquals(1, keyboard.depth)
        assertTrue(out.keyboardVisible)
    }

    @Test fun anEmptyInputMethodWindowIsNoKeyboard() {
        val ime = RawWindow(7, WindowKind.INPUT_METHOD, 20, "com.example.ime", Bounds(0, 2400, 1080, 2400), null)
        val out = QaHierarchy.assemble(listOf(appWindow(node("A")), ime), app, display)

        assertEquals(listOf("Application", "Window", "A"), out.nodes.map { it.type })
        assertFalse(out.keyboardVisible)
    }

    @Test fun anotherPackagesWindowAboveTheAppBecomesTheSnapshotUnderAnAlertRoot() {
        val dialogBounds = Bounds(80, 900, 1000, 1500)
        val dialog = RawWindow(
            5,
            WindowKind.APPLICATION,
            12,
            "com.android.permissioncontroller",
            dialogBounds,
            node("Dialog", packageName = "com.android.permissioncontroller", children = listOf(node("Allow", packageName = "com.android.permissioncontroller"))),
        )
        val out = QaHierarchy.assemble(listOf(appWindow(node("A")), dialog), app, display)

        assertEquals(listOf("Alert", "Dialog", "Allow"), out.nodes.map { it.type })
        assertNull(out.nodes[0].parentIndex)
        assertEquals(0, out.nodes[0].depth)
        assertEquals(dialogBounds, out.nodes[0].rect)
        assertEquals(listOf(null, 0, 1), out.nodes.map { it.parentIndex })
        assertEquals("com.android.permissioncontroller", out.nodes[2].packageName)
        assertFalse(out.eligible)
    }

    @Test fun anAlertKeepsTheKeyboardSoCoveredDialogTextIsNotRead() {
        val dialog = RawWindow(5, WindowKind.SYSTEM, 12, "android", Bounds(80, 900, 1000, 1500), node("Dialog"))
        val ime = RawWindow(7, WindowKind.INPUT_METHOD, 20, "com.example.ime", Bounds(0, 1500, 1080, 2400), null)
        val out = QaHierarchy.assemble(listOf(appWindow(node("A")), dialog, ime), app, display)

        assertEquals(listOf("Alert", "Dialog", "Keyboard"), out.nodes.map { it.type })
        assertEquals(0, out.nodes[2].parentIndex)
        assertTrue(out.keyboardVisible)
    }

    @Test fun systemBarsAndForeignWindowsBelowOrBesideTheAppAreNotAnAlert() {
        val windows = listOf(
            appWindow(node("A"), layer = 5, bounds = Bounds(0, 0, 1080, 2000)),
            RawWindow(2, WindowKind.SYSTEM, 30, QaHierarchy.SYSTEM_UI_PACKAGE, Bounds(0, 0, 1080, 2400), node("StatusBar")),
            RawWindow(3, WindowKind.APPLICATION, 1, "com.example.launcher", full, node("Launcher")),
            RawWindow(4, WindowKind.APPLICATION, 9, "com.example.pip", Bounds(0, 2000, 1080, 2400), node("Pip")),
        )
        val out = QaHierarchy.assemble(windows, app, display)

        assertEquals(listOf("Application", "Window", "A"), out.nodes.map { it.type })
        assertTrue(out.eligible)
    }

    @Test fun aForeignWindowWithAnUnreadablePackageFailsClosedAsAnAlert() {
        val unknown = RawWindow(5, WindowKind.APPLICATION, 12, null, Bounds(0, 0, 500, 500), null)
        val out = QaHierarchy.assemble(listOf(appWindow(node("A")), unknown), app, display)

        assertEquals(listOf("Alert"), out.nodes.map { it.type })
        assertEquals(1, out.droppedNodes)
    }

    @Test fun noAppWindowIsNoSnapshot() {
        val other = RawWindow(3, WindowKind.APPLICATION, 1, "com.example.launcher", full, node("Launcher"))
        assertNull(QaHierarchy.front(listOf(other), app))
    }

    @Test fun moreThanSixHundredNodesIsTruncated() {
        val leaves = (1..597).map { node("Leaf$it") }
        val exactly = QaHierarchy.assemble(listOf(appWindow(node("Root", children = leaves))), app, display)
        assertEquals(600, exactly.nodes.size)
        assertFalse(exactly.truncated)

        val over = QaHierarchy.assemble(
            listOf(appWindow(node("Root", children = leaves + node("Leaf598")))),
            app,
            display,
        )
        assertEquals(600, over.nodes.size)
        assertTrue(over.truncated)
    }

    @Test fun visibilitySelectionAndIdentityAreCopiedPerNode() {
        val tree = node(
            "android.widget.FrameLayout",
            children = listOf(
                node(
                    "android.widget.Button",
                    viewId = "com.example.app:id/save",
                    text = "",
                    desc = "Save draft",
                    selected = true,
                ),
                node("android.widget.TextView", text = "Hidden", visibleToUser = false),
                node("android.widget.EditText", desc = "email", password = true, enabled = false),
            ),
        )
        val out = QaHierarchy.assemble(listOf(appWindow(tree)), app, display)
        val (button, hidden, input) = out.nodes.drop(3)

        assertEquals("save", button.identifier)
        assertEquals("Save draft", button.label)
        assertTrue(button.selected)
        assertTrue(button.visibleToUser)
        assertTrue(button.hittable)
        assertFalse(hidden.visibleToUser)
        assertFalse(hidden.hittable)
        assertEquals("Hidden", hidden.label)
        assertEquals("email", input.identifier)
        assertTrue(input.secure)
        assertFalse(input.enabled)
        assertFalse(input.hittable)
        assertFalse(out.nodes[0].hittable)
        assertTrue(out.nodes.all { it.packageName.isNotEmpty() })
    }

    @Test fun aHeadingNodeKeepsItsHeadingFactAndOtherNodesDoNot() {
        val tree = node(
            "android.widget.FrameLayout",
            children = listOf(
                node("android.view.View", text = "Section title", heading = true),
                node("android.widget.TextView", text = "Body"),
            ),
        )
        val out = QaHierarchy.assemble(listOf(appWindow(tree)), app, display)
        val (frame, title, body) = out.nodes.drop(2)

        assertEquals("Section title", title.label)
        assertTrue(title.heading)
        assertFalse(body.heading)
        assertFalse(frame.heading)
        assertFalse(out.nodes[0].heading)
    }

    private val permissions = "com.google.android.permissioncontroller"

    private fun permissionDialog(vararg buttons: RawNode, id: Int = 5, owner: String = permissions) = RawWindow(
        id,
        WindowKind.APPLICATION,
        12,
        owner,
        Bounds(80, 900, 1000, 1500),
        node(
            "android.widget.LinearLayout",
            packageName = owner,
            children = listOf(node("android.widget.TextView", text = "Allow Test App to send you notifications?", packageName = owner)) +
                buttons.toList(),
        ),
    )

    private fun button(text: String?, desc: String? = null, enabled: Boolean = true) =
        node("android.widget.Button", text = text, desc = desc, packageName = permissions, enabled = enabled)

    private fun dialogFront(vararg windows: RawWindow) =
        QaHierarchy.front(listOf(appWindow(node("A"))) + windows.toList(), app)

    private fun refusal(match: QaHierarchy.DialogMatch): String? = (match as? QaHierarchy.DialogMatch.Refused)?.code

    @Test fun oneEnabledButtonWithARequestedLabelInAnOwnedDialogIsTheMatch() {
        val front = dialogFront(permissionDialog(button("Allow"), button("Don\u2019t allow")))
        val match = QaHierarchy.dialogMatch(front, listOf("Don\u2019t allow"), QaHierarchy.SYSTEM_DIALOG_OWNERS)

        assertEquals(QaHierarchy.DialogMatch.Button(5, listOf(2), "Don\u2019t allow"), match)
    }

    @Test fun aDuplicateLabelIsRefusedAsAmbiguous() {
        val front = dialogFront(permissionDialog(button("Allow"), button("Allow")))
        val match = QaHierarchy.dialogMatch(front, listOf("Allow"), QaHierarchy.SYSTEM_DIALOG_OWNERS)

        assertEquals("TARGET_AMBIGUOUS", refusal(match))
    }

    @Test fun anotherAppsDialogIsNeverASystemDialogEvenWithAnOk() {
        val front = dialogFront(permissionDialog(button("OK"), owner = "com.example.other"))
        val match = QaHierarchy.dialogMatch(front, listOf("OK"), QaHierarchy.SYSTEM_DIALOG_OWNERS)

        assertEquals("NO_SYSTEM_DIALOG", refusal(match))
    }

    @Test fun theAppInFrontGivesNoDialog() {
        val front = QaHierarchy.front(listOf(appWindow(node("A", children = listOf(node("Allow", text = "Allow"))))), app)
        val match = QaHierarchy.dialogMatch(front, listOf("Allow"), QaHierarchy.SYSTEM_DIALOG_OWNERS)

        assertTrue(front is QaHierarchy.Front.App)
        assertEquals("NO_SYSTEM_DIALOG", refusal(match))
        assertEquals("NO_SYSTEM_DIALOG", refusal(QaHierarchy.dialogMatch(null, listOf("Allow"), QaHierarchy.SYSTEM_DIALOG_OWNERS)))
    }

    @Test fun aDisabledButtonOrOneNamedOnlyByItsDescriptionIsNoMatch() {
        val front = dialogFront(permissionDialog(button("Allow", enabled = false), button(null, desc = "Allow")))
        val match = QaHierarchy.dialogMatch(front, listOf("Allow"), QaHierarchy.SYSTEM_DIALOG_OWNERS)

        assertEquals("NO_SYSTEM_DIALOG", refusal(match))
    }

    @Test fun theAlertIsClosedWhenTheAppIsInFrontAndItsWindowIsGone() {
        val before = dialogFront(permissionDialog(button("Allow"))) as QaHierarchy.Front.Alert

        assertTrue(QaHierarchy.closed(before, listOf(appWindow(node("A"))), app))
    }

    @Test fun aDifferentAlertWindowAfterTheTapIsNotClosed() {
        val before = dialogFront(permissionDialog(button("Allow"))) as QaHierarchy.Front.Alert
        val after = listOf(appWindow(node("A")), permissionDialog(button("Allow"), id = 9))

        assertFalse(QaHierarchy.closed(before, after, app))
    }

    @Test fun aTapWithNoClosureIsNotClosed() {
        val dialog = permissionDialog(button("Allow"))
        val before = dialogFront(dialog) as QaHierarchy.Front.Alert

        assertFalse(QaHierarchy.closed(before, listOf(appWindow(node("A")), dialog), app))
    }

    @Test fun theAlertWindowStillListedBehindTheAppIsNotClosed() {
        val before = dialogFront(permissionDialog(button("Allow"))) as QaHierarchy.Front.Alert
        val after = listOf(appWindow(node("A"), layer = 20), permissionDialog(button("Allow")))

        assertFalse(QaHierarchy.closed(before, after, app))
        assertFalse(QaHierarchy.closed(before, emptyList(), app))
    }

    private val statusBar = RawWindow(2, WindowKind.SYSTEM, 30, QaHierarchy.SYSTEM_UI_PACKAGE, Bounds(0, 0, 1080, 142), node("StatusBar"))

    @Test fun aSystemDialogStandingInForTheAppWindowIsTheAlert() {
        val windows = listOf(statusBar, permissionDialog(button("Allow"), button("Don’t allow")))
        val front = QaHierarchy.front(windows, app)
        val out = QaHierarchy.assemble(windows, app, display)

        assertEquals(5, (front as QaHierarchy.Front.Alert).window.id)
        assertEquals(
            listOf("Alert", "android.widget.LinearLayout", "android.widget.TextView", "android.widget.Button", "android.widget.Button"),
            out.nodes.map { it.type },
        )
        assertFalse(out.eligible)
        assertEquals(
            QaHierarchy.DialogMatch.Button(5, listOf(2), "Don’t allow"),
            QaHierarchy.dialogMatch(front, listOf("Don’t allow"), QaHierarchy.SYSTEM_DIALOG_OWNERS),
        )
    }

    @Test fun anotherAppsWindowStandingInForTheAppIsNoSnapshot() {
        val other = RawWindow(3, WindowKind.APPLICATION, 12, "com.example.other", full, node("Other"))
        val windows = listOf(statusBar, other, permissionDialog(button("OK"), owner = permissions).copy(layer = 9))

        assertNull(QaHierarchy.front(windows, app))
    }

    @Test fun theStandInAlertIsClosedOnlyWhenTheAppWindowIsBack() {
        val prompt = permissionDialog(button("Allow"), button("Don’t allow"))
        val before = QaHierarchy.front(listOf(statusBar, prompt), app) as QaHierarchy.Front.Alert

        assertTrue(QaHierarchy.closed(before, listOf(statusBar, appWindow(node("A"))), app))
        assertFalse(QaHierarchy.closed(before, listOf(statusBar, prompt), app))
        assertFalse(QaHierarchy.closed(before, listOf(statusBar), app))
        assertFalse(QaHierarchy.closed(before, listOf(statusBar, appWindow(node("A")), permissionDialog(button("Allow"), id = 9)), app))
    }

    private fun appWindow(
        root: RawNode?,
        id: Int = 1,
        layer: Int = 3,
        bounds: Bounds = full,
    ) = RawWindow(id, WindowKind.APPLICATION, layer, app, bounds, root)

    private fun node(
        className: String,
        bounds: Bounds? = Bounds(0, 0, 100, 100),
        children: List<RawNode?> = emptyList(),
        viewId: String? = null,
        text: String? = null,
        desc: String? = null,
        packageName: String = app,
        visibleToUser: Boolean = true,
        selected: Boolean = false,
        password: Boolean = false,
        enabled: Boolean = true,
        heading: Boolean = false,
    ) = RawNode(
        className = className,
        text = text,
        contentDescription = desc,
        viewIdResourceName = viewId,
        packageName = packageName,
        bounds = bounds,
        enabled = enabled,
        visibleToUser = visibleToUser,
        selected = selected,
        checked = false,
        password = password,
        heading = heading,
        children = children,
    )
}
