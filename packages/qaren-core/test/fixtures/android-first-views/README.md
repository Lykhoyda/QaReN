# Activity-top fixtures

The `complete-*.txt` fixtures come from complete Android 11 activity-top captures:
14.8 seconds into a fresh load, five seconds after the first visible screen,
and 4.7 seconds after force-stop during another fresh load. They preserve every
line and task/activity boundary. Package names, process IDs and object identities
are normalized; unrelated device state is redacted. The reader's section headers,
running-process syntax, hierarchy markers and React view classes are preserved.

H7e uses the rendered capture's surrounding tasks and the loading capture's app
task, then explicitly adds a synthetic foreign task with a React view. The raw
captures contain no such foreign task. H7g uses the force-stop capture, where the
app section is absent; it does not establish spontaneous-crash behavior or the
format of a retained dead app section.

The other fixtures are normalized app-section extracts from earlier loading,
first-views, rendered, launcher and unreadable captures.
