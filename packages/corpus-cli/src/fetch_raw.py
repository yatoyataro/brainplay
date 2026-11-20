"""Fetch & extract open-corpus raw sources into apps/prb-005-brainplay/.cache/corpus/ (stdlib only)."""
from __future__ import annotations

import bz2
import json
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CACHE_DIR = ROOT / ".cache" / "corpus"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

HEADERS = {"User-Agent": "WebDeveloperTeam-PRB005-CorpusCLI/1.0"}
WIKIDATA_HEADERS = {
    "User-Agent": "WebDeveloperTeam-PRB005-CorpusCLI/1.0 (https://github.com/yatoyataro/WebDeveloperTeam; build-time-corpus-ingest)",
    "Accept": "application/sparql-results+json",
}


def _parse_retry_after(raw: str | None) -> float | None:
    if not raw:
        return None
    try:
        return max(float(raw.strip()), 0.5)
    except ValueError:
        return None


def request_json_with_backoff(
    req: urllib.request.Request,
    max_retries: int = 5,
    timeout: int = 25,
) -> dict:
    """Execute HTTP JSON request with 429 Retry-After handling and exponential backoff."""
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_exc = exc
            retryable = exc.code == 429 or exc.code == 408 or 500 <= exc.code < 600
            if not retryable or attempt == max_retries - 1:
                raise
            retry_after = _parse_retry_after(exc.headers.get("Retry-After") if exc.headers else None)
            delay = (
                retry_after + random.uniform(0.1, 0.4)
                if retry_after is not None
                else 1.5 * (2 ** attempt) + random.uniform(0.1, 0.6)
            )
            time.sleep(delay)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            last_exc = exc
            if attempt == max_retries - 1:
                raise
            delay = 1.5 * (2 ** attempt) + random.uniform(0.1, 0.6)
            time.sleep(delay)
    raise RuntimeError(f"request_json_with_backoff exhausted retries: {last_exc}")

TATOEBA_FILES = {
    "kor_sentences_detailed.tsv": "https://downloads.tatoeba.org/exports/per_language/kor/kor_sentences_detailed.tsv.bz2",
    "jpn_sentences_detailed.tsv": "https://downloads.tatoeba.org/exports/per_language/jpn/jpn_sentences_detailed.tsv.bz2",
    "eng_sentences_detailed.tsv": "https://downloads.tatoeba.org/exports/per_language/eng/eng_sentences_detailed.tsv.bz2",
    "kor-eng_links.tsv": "https://downloads.tatoeba.org/exports/per_language/kor/kor-eng_links.tsv.bz2",
    "eng-jpn_links.tsv": "https://downloads.tatoeba.org/exports/per_language/eng/eng-jpn_links.tsv.bz2",
}


def download_bz2_tsv(out_name: str, url: str) -> Path:
    dest = CACHE_DIR / out_name
    if dest.exists() and dest.stat().st_size > 0:
        print(f"[cache hit] {dest.name} ({dest.stat().st_size} bytes)")
        return dest
    print(f"[fetch] {url}")
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=60) as resp:
        compressed = resp.read()
    raw_bytes = bz2.decompress(compressed)
    dest.write_bytes(raw_bytes)
    print(f"[saved] {dest.name} ({len(raw_bytes)} bytes)")
    return dest


def fetch_opentdb(target_count: int = 450, category: int | None = None, filename: str = "opentdb_raw.json") -> Path:
    dest = CACHE_DIR / filename
    if dest.exists() and dest.stat().st_size > 1000:
        existing = json.loads(dest.read_text(encoding="utf-8"))
        if len(existing) >= min(target_count, 180 if category == 31 else target_count):
            print(f"[cache hit] {filename} ({len(existing)} items)")
            return dest

    tok_req = urllib.request.Request("https://opentdb.com/api_token.php?command=request", headers=HEADERS)
    token = ""
    try:
        with urllib.request.urlopen(tok_req, timeout=15) as r:
            tok_data = json.loads(r.read().decode("utf-8"))
            token = tok_data.get("token", "")
    except Exception:
        token = ""

    items: list[dict] = []
    seen_q: set[str] = set()
    attempts = 0
    max_attempts = 6 if category == 31 else 14
    while len(items) < target_count and attempts < max_attempts:
        attempts += 1
        url = "https://opentdb.com/api.php?amount=50&type=multiple&encode=url3986"
        if category is not None:
            url += f"&category={category}"
        if token:
            url += f"&token={token}"
        req = urllib.request.Request(url, headers=HEADERS)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                payload = json.loads(r.read().decode("utf-8"))
            code = payload.get("response_code", -1)
            if code == 5:
                time.sleep(5.5)
                continue
            for row in payload.get("results", []):
                q = row.get("question", "")
                if q and q not in seen_q:
                    seen_q.add(q)
                    items.append(row)
            if code == 4:
                break
        except Exception as exc:
            print(f"[warn] opentdb {filename} attempt {attempts}: {exc}", file=sys.stderr)
        time.sleep(5.3)

    dest.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[saved] {filename} ({len(items)} items)")
    return dest


def fetch_anilist_anime(pages: int = 8) -> Path:
    dest = CACHE_DIR / "anilist_anime_raw.json"
    if dest.exists() and dest.stat().st_size > 10_000:
        existing = json.loads(dest.read_text(encoding="utf-8"))
        if len(existing) >= 300:
            print(f"[cache hit] anilist_anime_raw.json ({len(existing)} titles)")
            return dest

    query = """
    query ($page: Int) {
      Page(page: $page, perPage: 50) {
        media(type: ANIME, sort: POPULARITY_DESC, isAdult: false) {
          id
          title { romaji english native }
          seasonYear
          format
          source
          episodes
          genres
          studios(isMain: true) { nodes { name } }
        }
      }
    }
    """
    all_media: list[dict] = []
    seen_ids: set[int] = set()

    for page in range(1, pages + 1):
        payload = json.dumps({"query": query, "variables": {"page": page}}).encode("utf-8")
        req = urllib.request.Request(
            "https://graphql.anilist.co",
            data=payload,
            headers={"Content-Type": "application/json", **HEADERS},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode("utf-8"))
            for m in data.get("data", {}).get("Page", {}).get("media", []):
                mid = m.get("id")
                if mid and mid not in seen_ids:
                    seen_ids.add(mid)
                    all_media.append(m)
        except Exception as exc:
            print(f"[warn] anilist page {page}: {exc}", file=sys.stderr)
        time.sleep(0.8)

    dest.write_text(json.dumps(all_media, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[saved] anilist_anime_raw.json ({len(all_media)} titles)")
    return dest


def fetch_kitsu_anime(pages: int = 12) -> Path:
    dest = CACHE_DIR / "kitsu_anime_raw.json"
    if dest.exists() and dest.stat().st_size > 10_000:
        existing = json.loads(dest.read_text(encoding="utf-8"))
        if len(existing) >= 200:
            print(f"[cache hit] kitsu_anime_raw.json ({len(existing)} titles)")
            return dest

    rows: list[dict] = []
    seen_ids: set[str] = set()
    for p in range(pages):
        offset = p * 20
        url = (
            f"https://kitsu.io/api/edge/anime?page[limit]=20&page[offset]={offset}"
            "&sort=-userCount&fields[anime]=canonicalTitle,titles,startDate,subtype,episodeCount,ageRating"
        )
        req = urllib.request.Request(
            url,
            headers={"Accept": "application/vnd.api+json", **HEADERS},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                data = json.loads(r.read().decode("utf-8"))
            for item in data.get("data", []):
                aid = str(item.get("id", ""))
                if aid and aid not in seen_ids:
                    seen_ids.add(aid)
                    rows.append({"id": aid, **item.get("attributes", {})})
        except Exception as exc:
            print(f"[warn] kitsu offset {offset}: {exc}", file=sys.stderr)
        time.sleep(0.4)

    dest.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[saved] kitsu_anime_raw.json ({len(rows)} titles)")
    return dest


def _has_enriched_anilist_character_schema(existing: object) -> bool:
    if not isinstance(existing, list) or len(existing) < 750:
        return False
    for char in existing[:15]:
        if not isinstance(char, dict):
            continue
        name_obj = char.get("name")
        if not isinstance(name_obj, dict) or "alternativeSpoiler" not in name_obj:
            return False
        edges = (char.get("media") or {}).get("edges") or []
        if any(
            isinstance(edge, dict)
            and isinstance(edge.get("node"), dict)
            and "tags" in edge["node"]
            and "relations" in edge["node"]
            for edge in edges
        ):
            return True
    return False


def fetch_anilist_characters(pages: int = 18) -> Path:
    dest = CACHE_DIR / "anilist_characters_raw.json"
    if dest.exists() and dest.stat().st_size > 20_000:
        try:
            existing = json.loads(dest.read_text(encoding="utf-8"))
        except Exception:
            existing = []
        if _has_enriched_anilist_character_schema(existing):
            print(f"[cache hit] anilist_characters_raw.json ({len(existing)} characters)")
            return dest
        print("[cache refresh] anilist_characters_raw.json missing tags/relations/alternativeSpoiler")

    query = """
    query ($page: Int) {
      Page(page: $page, perPage: 50) {
        characters(sort: FAVOURITES_DESC) {
          id
          name { full native alternative alternativeSpoiler }
          gender
          age
          favourites
          description(asHtml: false)
          media(type: ANIME, sort: POPULARITY_DESC, page: 1, perPage: 3) {
            edges {
              characterRole
              voiceActors(language: JAPANESE, sort: FAVOURITES_DESC) {
                name { full native }
              }
              node {
                id
                isAdult
                title { english romaji }
                seasonYear
                format
                genres
                studios(isMain: true) { nodes { name } }
                tags { name rank isMediaSpoiler }
                relations {
                  edges {
                    relationType
                    node {
                      id
                      title { english romaji }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    """
    chars: list[dict] = []
    seen_ids: set[int] = set()

    for page in range(1, pages + 1):
        payload = json.dumps({"query": query, "variables": {"page": page}}).encode("utf-8")
        req = urllib.request.Request(
            "https://graphql.anilist.co",
            data=payload,
            headers={"Content-Type": "application/json", **HEADERS},
        )
        try:
            data = request_json_with_backoff(req, max_retries=5, timeout=25)
            for c in (data.get("data") or {}).get("Page", {}).get("characters", []):
                cid = c.get("id")
                if cid and cid not in seen_ids:
                    seen_ids.add(cid)
                    chars.append(c)
        except Exception as exc:
            print(f"[warn] anilist chars page {page} failed: {exc}", file=sys.stderr)
        time.sleep(0.9)

    if chars or not dest.exists():
        dest.write_text(json.dumps(chars, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[saved] anilist_characters_raw.json ({len(chars)} characters)")
    return dest


def fetch_wikidata_characters_cc0() -> Path:
    """Non-fatal CC0 1.0 structured anime/manga character facts via Wikidata SPARQL."""
    dest = CACHE_DIR / "wikidata_characters_cc0.json"
    if dest.exists() and dest.stat().st_size > 1000:
        try:
            existing = json.loads(dest.read_text(encoding="utf-8"))
            if isinstance(existing, list) and len(existing) > 0:
                print(f"[cache hit] wikidata_characters_cc0.json ({len(existing)} characters)")
                return dest
        except Exception:
            pass

    sparql = """
    SELECT DISTINCT ?char ?charLabel ?charAltLabel ?workLabel ?roleLabel ?occupationLabel ?abilityLabel WHERE {
      VALUES ?charType { wd:Q80447738 wd:Q87576284 }
      ?char wdt:P31 ?charType .
      ?char wdt:P1441 ?work .
      ?char rdfs:label ?charLabel . FILTER(LANG(?charLabel) = "en")
      ?work rdfs:label ?workLabel . FILTER(LANG(?workLabel) = "en")
      OPTIONAL { ?char skos:altLabel ?charAltLabel . FILTER(LANG(?charAltLabel) = "en") }
      OPTIONAL { ?char wdt:P2868 ?role . ?role rdfs:label ?roleLabel . FILTER(LANG(?roleLabel) = "en") }
      OPTIONAL { ?char wdt:P106 ?occ . ?occ rdfs:label ?occupationLabel . FILTER(LANG(?occupationLabel) = "en") }
      OPTIONAL { ?char wdt:P2563 ?ability . ?ability rdfs:label ?abilityLabel . FILTER(LANG(?abilityLabel) = "en") }
    }
    LIMIT 300
    """.strip()

    url = "https://query.wikidata.org/sparql?" + urllib.parse.urlencode(
        {"query": sparql, "format": "json"}
    )
    req = urllib.request.Request(url, headers=WIKIDATA_HEADERS)

    try:
        payload = request_json_with_backoff(req, max_retries=2, timeout=25)
        bindings = (payload.get("results") or {}).get("bindings") or []
        grouped: dict[str, dict] = {}
        for row in bindings:
            uri = (row.get("char") or {}).get("value", "")
            label = (row.get("charLabel") or {}).get("value", "").strip()
            if not uri or not label:
                continue
            qid = uri.rsplit("/", 1)[-1]
            rec = grouped.setdefault(
                qid,
                {
                    "wikidata_id": qid,
                    "label": label,
                    "aliases": set(),
                    "works": set(),
                    "roles": set(),
                    "occupations": set(),
                    "abilities": set(),
                    "license_id": "CC0-1.0",
                },
            )
            for field, key in (
                ("charAltLabel", "aliases"),
                ("workLabel", "works"),
                ("roleLabel", "roles"),
                ("occupationLabel", "occupations"),
                ("abilityLabel", "abilities"),
            ):
                val = (row.get(field) or {}).get("value", "").strip()
                if val:
                    rec[key].add(val)

        normalized = [
            {
                "wikidata_id": rec["wikidata_id"],
                "label": rec["label"],
                "aliases": sorted(rec["aliases"]),
                "works": sorted(rec["works"]),
                "roles": sorted(rec["roles"]),
                "occupations": sorted(rec["occupations"]),
                "abilities": sorted(rec["abilities"]),
                "license_id": "CC0-1.0",
            }
            for rec in grouped.values()
        ]
        dest.write_text(json.dumps(normalized, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"[saved] wikidata_characters_cc0.json ({len(normalized)} characters, CC0-1.0)")
    except Exception as exc:
        print(f"[warn] wikidata CC0 SPARQL skipped (non-fatal): {exc}", file=sys.stderr)
        dest.write_text("[]\n", encoding="utf-8")

    return dest


def main() -> int:
    for name, url in TATOEBA_FILES.items():
        download_bz2_tsv(name, url)
    fetch_opentdb(450, category=None, filename="opentdb_raw.json")
    fetch_opentdb(210, category=31, filename="opentdb_anime_raw.json")
    fetch_anilist_anime(pages=8)
    fetch_kitsu_anime(pages=10)
    fetch_anilist_characters(pages=18)
    fetch_wikidata_characters_cc0()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
