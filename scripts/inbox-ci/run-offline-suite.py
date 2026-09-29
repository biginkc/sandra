#!/usr/bin/env python3
"""Run install unit tests, excluding the separately run live catalog module.

Send stdout to stderr so noisy diagnostics precede unittest's final status
in the lane's combined log; the assertion checks its last line for ``OK``.
"""
import sys
import unittest

sys.stdout = sys.stderr


def offline_tests(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from offline_tests(item)
        elif not item.id().split('.', 1)[0] == 'test_catalog_fingerprint_live':
            yield item


tests = unittest.defaultTestLoader.discover(sys.argv[1], pattern='test_*.py')
result = unittest.TextTestRunner(verbosity=1).run(unittest.TestSuite(offline_tests(tests)))
sys.exit(0 if result.wasSuccessful() else 1)
