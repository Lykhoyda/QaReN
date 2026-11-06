package dev.lykhoyda.rndevagent.androidrunner

// AI-489: a transparent input is not visible to the user yet can hold input focus;
// only then does typing go where the user's keystrokes would.
object FocusedHiddenInput {
    fun eligible(
        isInputClass: Boolean,
        classMatches: Boolean,
        editable: Boolean,
        enabled: Boolean,
        focused: Boolean,
        visibleToUser: Boolean,
        boundsEmpty: Boolean,
        packageMatches: Boolean,
        frameMatches: Boolean,
    ): Boolean =
        !visibleToUser && !boundsEmpty &&
            isInputClass && classMatches && editable && enabled && focused &&
            packageMatches && frameMatches
}
