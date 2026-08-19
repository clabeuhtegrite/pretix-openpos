"""
Settings for ``makemigrations --check``, and for nothing else.

Same stack as :mod:`tests.settings`, minus the one thing that would make the
check meaningless: with migrations disabled, Django sees no migration modules at
all and cheerfully offers to write the initial ones — every time, for a plugin
whose migrations are right there in the tree.
"""
from pretix.testutils.settings import *  # noqa: F401,F403

# Django's own default. Restored explicitly because pretix' test settings switch
# migrations off depending on whether they think they are running in CI.
MIGRATION_MODULES = {}
