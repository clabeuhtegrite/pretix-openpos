#!/usr/bin/env python3
"""
Every local link on the presentation site points at something that exists.

The site is four hand-written translations of one page sharing one stylesheet
and three screenshots, and the pages live at different depths — ``site/`` and
``site/<lang>/`` — so every asset is referenced once as ``assets/…`` and three
times as ``../assets/…``. A missing file is the one failure a pile of static
HTML can actually have, and it is invisible until somebody visits the page.

Checked here rather than by fetching the deployed site: this runs on the pull
request, before anyone sees it.

Also checks that the four pages agree on which languages exist, because a
translation added without a link from the other three is a page nobody reaches.

No dependencies on purpose. It runs on a bare runner with nothing installed.
"""
import os
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent / "site"
LANGS = {"en": SITE / "index.html", "fr": SITE / "fr" / "index.html",
         "es": SITE / "es" / "index.html", "de": SITE / "de" / "index.html"}

#: Attributes that name something the browser will go and fetch.
WANTED = {"a": "href", "link": "href", "img": "src", "script": "src"}


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.found: list[tuple[str, str]] = []
        self.ids: set[str] = set()

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if (name := attrs.get("id")):
            self.ids.add(name)
        if (attr := WANTED.get(tag)) and (value := attrs.get(attr)):
            self.found.append((tag, value))


def check(page: Path, problems: list[str]) -> None:
    parser = Links()
    parser.feed(page.read_text(encoding="utf-8"))
    where = page.relative_to(SITE.parent)

    for tag, link in parser.found:
        if re.match(r"^(https?:|mailto:|data:|//)", link):
            continue
        target, _, fragment = link.partition("#")

        if not target:
            # A bare "#anchor": it has to name an id on this very page.
            if fragment and fragment not in parser.ids:
                problems.append(f"{where}: <{tag}> points at #{fragment}, which is not on the page")
            continue

        resolved = (page.parent / target).resolve()
        # A link ending in "/" (or "./", or "../") is a directory, and what the
        # server actually serves from it is its index.html.
        if target.endswith("/"):
            resolved = resolved / "index.html"
        if not resolved.exists():
            problems.append(f"{where}: <{tag}> points at {link!r}, which is not a file")


def main() -> int:
    problems: list[str] = []

    for lang, page in LANGS.items():
        if not page.exists():
            problems.append(f"the {lang} page is missing: {page.relative_to(SITE.parent)}")
            continue
        check(page, problems)

        html = page.read_text(encoding="utf-8")
        # Every page offers every language, itself included, or one of the four
        # becomes a page you can only reach by typing its URL.
        for other in LANGS:
            if f'hreflang="{other}"' not in html:
                problems.append(f"the {lang} page never links to the {other} one")
        if f'<html lang="{lang}"' not in html:
            problems.append(f"the {lang} page does not declare lang=\"{lang}\"")

    # ::error:: makes GitHub show the line in the run summary rather than only
    # in the log; anywhere else it would just be noise in front of the message.
    prefix = "::error::" if os.environ.get("GITHUB_ACTIONS") else ""
    for problem in problems:
        print(f"{prefix}{problem}", file=sys.stderr)

    if problems:
        print(f"\n{len(problems)} problem(s) on the site.", file=sys.stderr)
        return 1
    print(f"{len(LANGS)} pages, every local link resolves.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
