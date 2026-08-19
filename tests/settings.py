"""
Settings for the plugin's own test suite.

pretix ships the settings its own suite runs on, and reusing them is what makes
these tests exercise the real thing: the real ORM, the real order pipeline, the
real check-in service, the real device authentication. The plugin is picked up
the way it is in production — through its ``pretix.plugin`` entry point, which
pretix appends to ``INSTALLED_APPS``.

Only one thing is overridden. pretix' test settings keep migrations *on* when
they detect GitHub Actions, so that its own CI exercises them; replaying the
whole of pretix' migration history costs minutes per run and tells us nothing
about this plugin. The schema is built straight from the models instead — the
plugin's own migrations are checked by ``makemigrations --check`` in CI, which
is the question that actually matters here.
"""
from pretix.testutils.settings import *  # noqa: F401,F403


class DisableMigrations:
    def __contains__(self, item):
        return True

    def __getitem__(self, item):
        return None

    def setdefault(self, key, default=None):
        return


MIGRATION_MODULES = DisableMigrations()

# The dummy cache pretix' test settings wire in is kept: it stores nothing, so
# no test can pass on a value another test left behind. The two tests that are
# *about* caching ask for a real one themselves, with `real_cache`.
