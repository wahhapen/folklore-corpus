# Lawful heterogeneous archive pair for Corpus v0.2

- Date: 2026-07-24
- Resolves: [issue #2](https://github.com/wahhapen/folklore-corpus/issues/2)
- Decision status: recommended for implementation

## Decision

Use:

1. **SKVR (Suomen Kansan Vanhat Runot)** as the structured-text
   archive; and
2. **LibriVox, _Celtic Fairy Tales_, book 1837** as the audio archive.

This is the best v0.2 pair because it is implementable without accepting a
noncommercial corpus licence or pretending that “available online” means
“cleared for redistribution”:

- SKVR publishes its XML/TEI data under **CC BY 4.0**, supports filtered and
  complete XML downloads, assigns electronic poem IDs, and publishes persistent
  URNs.
- LibriVox states that its recordings are donated to the public domain and
  exposes an official JSON/XML API with stable book and section IDs. Book 1837
  is explicitly linked to Project Gutenberg 7885, already represented in
  Corpus v0.1, so it creates a useful text/audio bridge without collapsing the
  recording into the printed witness.

The pair is heterogeneous in both source shape and provenance:

| SKVR | LibriVox |
| --- | --- |
| TEI/XML corpus export | JSON/XML catalogue plus audio on Internet Archive |
| Source-defined poems and lines | Book, section, reader, duration, and audio files |
| Original and normalized text views | Recorded readings derived from a named print text |
| Collector, performer, place, date, and poem-type metadata | Reader, section, source-text link, and recording duration |
| CC BY 4.0 | Public-domain recording declaration; jurisdiction check for source text |

This is an **adapter and evidence-model release**, not a claim that 100 Finnic
poems and one English-language audiobook are representative of world folklore.

## Exact pilot slices

### SKVR: 100 base records from part I1

Ingest exactly the 100 base poem records whose electronic IDs match:

```text
skvr011{NNNN}0
```

where `{NNNN}` is the zero-padded decimal sequence `0001` through `0100`.
Equivalently, this is SKVR part `I1`, printed poem numbers 1 through 100,
excluding letter-suffixed alternate records.

The endpoints begin with
[`skvr01100010`](https://aineistot.finlit.fi/exist/apps/skvr/main/skvr01100010.xml)
and end with
[`skvr01101000`](https://aineistot.finlit.fi/exist/apps/skvr/main/skvr01101000.xml).
The adapter must materialize the 100 IDs into a checked-in pilot manifest
before capture. A missing, duplicate, or changed ID set is a preflight failure,
not permission to silently substitute another poem.

Why this slice:

- it is small enough for repeated integration tests;
- it is source-ordered rather than selected by an English keyword or a
  model-generated notion of “interesting” folklore;
- it exercises Finnic-language text, verse lines, notes, collector/place/date
  metadata, archive normalization, electronic IDs, and persistent URNs; and
- it adds a source tradition and source language absent from the English-only
  v0.1 seed.

SKVR's official instructions say that the XML/TEI data is downloadable and
modifiable under
[CC BY 4.0](https://aineistot.finlit.fi/exist/apps/skvr/ohjeet.html).
They also document:

- citation by printed part and poem number;
- electronic IDs such as `skvr06138370`;
- a persistent URN for every poem;
- complete or filtered XML downloads and CSV metadata downloads; and
- metadata fields for part, number, archive signum, collector, year, region,
  place, village, and performer.

The [SKVR service introduction](https://aineistot.finlit.fi/exist/apps/skvr/index.html)
describes the corpus as Karelian, Ingrian, and Finnish folk poetry drawn from
the published SKVR series, with a separate, unchecked JR corpus added to the
service. **Do not include JR in v0.2.** The service documentation says JR is
unchecked and describes additional anonymization work on it; mixing it into
this pilot would add quality and privacy variables unrelated to the adapter
test.

### LibriVox: _Celtic Fairy Tales_, book 1837

Ingest exactly:

```text
LibriVox book ID:       1837
Section IDs:            153266 through 153292 inclusive
Sections:               27, including the preface
Recorded duration:      6:27:42
Internet Archive ID:    celtic_fairy_tales_0903_librivox
Declared source text:   Project Gutenberg 7885
```

Primary records:

- [LibriVox book page](https://librivox.org/celtic-fairy-tales-by-joseph-jacobs/)
- [Exact extended API record](https://librivox.org/api/feed/audiobooks?id=1837&format=json&extended=1)
- [LibriVox API documentation](https://librivox.org/api/info)
- [LibriVox public-domain policy](https://librivox.org/pages/about-librivox/)
- [Project Gutenberg 7885](https://www.gutenberg.org/ebooks/7885)

Why this slice:

- it is bounded and fully enumerable through source-native numeric IDs;
- it proves capture across two hosts: LibriVox catalogue evidence and Internet
  Archive audio artifacts;
- it tests multi-reader section metadata, durations, binary streaming,
  content hashing, and time-based citation;
- it creates a controlled ML experiment: align a known text witness with
  independently recorded audio and measure narration differences; and
- its overlap with v0.1 is useful here. The same tale text and a later reading
  should be related by evidence, not deduplicated into one Witness.

LibriVox says recordings are donated to the public domain and may be used for
any purpose. Its item and Project Gutenberg both warn users to check the
copyright status applicable in their jurisdiction. The release must therefore
record separately:

1. the LibriVox declaration for the recording;
2. the rights statement on the linked source text;
3. the applicable-jurisdiction review result; and
4. the date and exact pages from which those statements were captured.

The API can be slow or transiently unavailable. Capture the API response as an
Artifact, use retry/backoff, and never rebuild membership from titles.

## Candidate comparison

### Structured-text candidates

| Candidate | Rights and redistribution | Machine access | Identity and provenance | Folklore value | Decision |
| --- | --- | --- | --- | --- | --- |
| **SKVR** | XML/TEI explicitly CC BY 4.0 | Complete/filtered XML; CSV metadata; individual poem views | Electronic poem ID, printed citation, persistent URN, archive signum, collector, performer, place, and date | Directly adds Finnic folk poetry and source-language evidence | **Choose** |
| **Dúchas Schools' Collection** | Collection-wide policy says CC BY-NC 4.0 and asks users to contact the archive about republication | Per-school, page, and story XML, but the site says XML will be deprecated for a future JSON API | Excellent hierarchy: stable numeric IDs, archival volume/page, manuscript image, transcript, school, collector/informant, place, topic, and revision metadata | Exceptional 1930s Irish field collection with scans and crowd transcriptions | Defer pending permission or acceptance of a separate NC release |
| **Project Gutenberg** | Item-level public-domain notices are clear for the existing US release context | RDF catalogue, mirrors, and text downloads | Stable eBook number, but its [catalogue documentation](https://www.gutenberg.org/ebooks/offline_catalogs.html) warns that eBooks may differ from or combine source editions and can omit original publication dates | Useful edited anthologies, already the entire v0.1 source class | Do not use as the “new” structured adapter |
| **Wikisource** | Its [copyright policy](https://en.wikisource.org/wiki/Wikisource:Copyright_policy) requires public-domain or freely licensed works, with item-level copyright templates | Mature [MediaWiki API](https://www.mediawiki.org/wiki/API:Main_page) and revision history | Stable page/revision IDs, but edition choice and transcription provenance vary by work and community | Broad coverage but a less controlled first institutional adapter | Later source, after edition-selection policy |

Dúchas is the strongest runner-up. Its
[rights policy](https://www.duchas.ie/en/info/contact) states CC BY-NC 4.0,
requires attribution, and says archive/research material may be used with
acknowledgement while asking users to contact the archive about republication.
Individual Schools' Collection pages expose manuscript images, transcripts,
metadata, and XML, but also announce the planned XML-to-JSON transition. For
example, the
[Athboy school](https://www.duchas.ie/en/cbes/5008948) currently exposes 54
transcribed story links and source-native numeric school/page/story paths.

Dúchas should become a later adapter after one of these decisions is explicit:

- the project accepts a separately licensed noncommercial release;
- Dúchas grants broader permission in writing; or
- the project ingests only metadata and links while excluding licensed
  manuscript/transcript bytes from unrestricted releases and ML projections.

Do not rely on occasional item-page snippets that appear to say CC BY 4.0; the
collection-wide policy and transcription policy say CC BY-NC 4.0, so the
stricter statement governs until the archive clarifies it.

### Audio or scan-oriented candidates

| Candidate | Rights and redistribution | Machine access | Identity and provenance | Folklore value | Decision |
| --- | --- | --- | --- | --- | --- |
| **LibriVox** | Recordings declared public domain; source-text jurisdiction still must be checked | Official JSON/XML API; section metadata; audio delegated to Internet Archive | Stable book and section IDs, reader, duration, IA identifier, and explicit source-text URL | Narrated edited folklore rather than field performance, but excellent text/audio bridge | **Choose for v0.2** |
| **Library of Congress California Gold** | LOC is unaware of US copyright but explicitly warns about underlying works plus privacy/publicity rights; this is not a permissive licence | Excellent public JSON API plus downloadable MP3/WAV masters | Stable LOC item ID, LCCN/resource IDs, performer, collector, date/place, field notes, and multiple metadata formats | Far superior authentic field audio: 35 hours, 12 languages, 185 musicians | Build next as metadata/research capture; do not redistribute audio yet |
| **Dúchas audio/scans** | CC BY-NC 4.0 collection policy | Downloadable low/medium-resolution media and XML; API transition pending | Strong archive hierarchy and cultural context | Authentic Irish folklore evidence | Same NC blocker as the structured collection |
| **Europeana SOUND/IIIF** | Metadata is standardized, but media rights remain item/provider-specific | Search and Record APIs plus some IIIF; free account and API key required | Europeana record plus upstream provider IDs; content may remain upstream | Very broad but operationally and legally variable | Too many provider and rights variables for the first media adapter |

The
[California Gold collection](https://www.loc.gov/collections/sidney-robertson-cowell-northern-california-folk-music/)
is the correct authentic field-audio follow-up. The collection describes 35
hours of music in 12 languages from 185 musicians, together with photographs,
instrument drawings, field notes, and written documentation. Its catalogue
currently exposes 814 audio-recording items, 215 manuscript/mixed-material
items, and 212 photographs.

The official
[LOC rights page](https://www.loc.gov/collections/sidney-robertson-cowell-northern-california-folk-music/about-this-collection/rights-and-access/)
says the Library is unaware of US copyright or other restrictions, but it also
says:

- users must make their own legal assessment;
- underlying works in sound recordings may retain rights;
- performers/interviewees were not US Government employees; and
- privacy and publicity rights may apply.

That is strong enough for a metadata adapter and controlled research capture,
not for an unrestricted redistributable corpus or ML release. The best bounded
clearance candidate is the collection's 49 Icelandic sound-recording items,
returned by the
[official collection query for `language:icelandic`](https://www.loc.gov/collections/sidney-robertson-cowell-northern-california-folk-music/?fo=json&c=150&fa=language:icelandic).
Their LOC item numbers are exactly:

```text
2017700886–2017700888
2017700928–2017700929
2017700935–2017700936
2017701458–2017701481
2017701867–2017701868
2017701903–2017701914
2017702107–2017702110
```

Every one of those 49 query results is a sound recording. They are a coherent
target for an item-level rights review and a future authentic-audio adapter.

LOC's official documentation confirms that:

- the [JSON/YAML API](https://www.loc.gov/apis/json-and-yaml/) is public and
  requires no API key;
- collection results provide item IDs that lead to detailed
  [item/resource responses](https://www.loc.gov/apis/json-and-yaml/responses/item-and-resource/);
- item responses expose downloadable media resources; and
- the published [rate limits](https://www.loc.gov/apis/json-and-yaml/working-within-limits/)
  are 20 JSON requests/minute and 60 streaming-service requests/minute, with
  possible `429` or CAPTCHA responses under load.

Europeana is useful for later discovery, but its own
[API portal](https://api.europeana.eu/en) requires a free account/API key and
describes access across thousands of contributing institutions. That
aggregator boundary is exactly why it is a poor first media adapter: metadata
rights, digital-object rights, stable upstream access, and provenance must all
be checked per provider.

## Adapter implications

### SKVR adapter

Map the archive without turning archive interpretations into identity:

| Corpus resource | SKVR source |
| --- | --- |
| Archive | SKS / SKVR web service |
| Source Item | electronic poem ID; retain printed citation and persistent URN |
| Edition | SKVR web publication and printed part `I1` context |
| Document | source-defined poem record |
| Witness | the attested poem text represented by that record |
| Representation | captured TEI; archive-normalized text as a distinct representation/view |
| Passage | source line or source-defined subdivision, never an arbitrary token chunk |
| Claim | poem type, normalized place, cultural attribution, or later inferred relationship |

Capture the filtered bulk XML as immutable evidence and retain its digest.
Derive per-poem Artifacts deterministically from that captured export, recording
the parser version and XPath/TEI selectors. Do not fetch 100 HTML pages and call
the rendered pages the source dataset.

Preserve:

- all source IDs and URNs as aliases/identifiers;
- the TEI namespace and unrecognized elements;
- source spelling separately from normalized text;
- collection and performer names exactly as published, including missing or
  anonymous values; and
- the CC BY 4.0 attribution and captured rights evidence in the Release.

### LibriVox adapter

LibriVox catalogue evidence and Internet Archive media are separate Captures:

| Corpus resource | LibriVox/IA source |
| --- | --- |
| Archive | LibriVox, with Internet Archive recorded as media host |
| Source Item | LibriVox book ID 1837 and section IDs 153266–153292 |
| Edition | the LibriVox audiobook |
| Document | source-defined audiobook section |
| Witness | the particular reader's recorded performance of that section |
| Representation | section audio Artifact; do not use the full-book ZIP as a second witness |
| Passage | whole section initially (`0` to recorded duration); later time spans are derived |
| Claim | relation to PG 7885 text, reader attribution, and proposed text/audio alignment |

Do not assert that the MP3 is a corpus-derived version of a WAV unless the
project itself performs and records that conversion. LibriVox/Internet Archive
may expose multiple encodings without publishing a derivation process; capture
them as source-provided representations with their own digests.

Forced alignment and transcripts are derived Representations. Their passages
must use time selectors and record model/tool version, parameters, and the exact
audio/text inputs. A narration mismatch is evidence, not an error to silently
correct.

### Rights and release gate

The current schema can hide rights strings in generic `metadata`, but v0.2
publication needs a normalized, testable rights gate. At minimum, every
captured or derived byte-bearing Representation needs:

```text
rights statement URI or controlled status
rights holder/source
attribution text
commercial-use allowed: yes / no / unknown
derivatives allowed: yes / no / unknown
redistribution allowed: yes / no / unknown
jurisdiction and review date
captured evidence Artifact
```

Release validation must fail closed when a member's redistribution or ML-use
status is `unknown`. Rights do not inherit blindly from an Archive to every
item, and a metadata licence does not automatically license media bytes.

For the chosen pair, v0.2 may include:

- SKVR TEI and derived text under CC BY 4.0 with attribution; and
- LibriVox audio only after the source-text jurisdiction check is recorded.

Do not include Dúchas bytes in a commercially reusable release, and do not
include LOC audio bytes in any unrestricted release, until the corresponding
permission/review gate is satisfied.

## Acceptance checks for implementation

The two adapters are complete only when tests prove:

1. the SKVR manifest contains exactly 100 expected electronic IDs;
2. the LibriVox manifest contains book 1837 and exactly section IDs
   153266–153292;
3. rerunning either adapter creates new Captures when appropriate but no
   duplicate logical Source Items, Witnesses, or Representations;
4. every released passage traces to captured TEI or audio bytes;
5. SKVR source and normalized text remain distinguishable;
6. each LibriVox section retains reader, duration, source-text link, API
   response digest, media URL, and media digest;
7. rights evidence and attribution are release members, and an unknown right
   blocks publication;
8. Search can cite an SKVR poem/line and a LibriVox section/time range; and
9. ML Lab can build a small text/audio alignment experiment without treating
   the aligned transcript as source truth.

## Sources

Only first-party archive, API, catalogue, and policy documentation was used:

- [SKVR service](https://aineistot.finlit.fi/exist/apps/skvr/index.html)
- [SKVR licence, identity, download, and search instructions](https://aineistot.finlit.fi/exist/apps/skvr/ohjeet.html)
- [Dúchas rights and access policy](https://www.duchas.ie/en/info/contact)
- [Dúchas Schools' Collection](https://www.duchas.ie/en/cbes/schools)
- [Project Gutenberg machine-readable catalogues](https://www.gutenberg.org/ebooks/offline_catalogs.html)
- [Wikisource copyright policy](https://en.wikisource.org/wiki/Wikisource:Copyright_policy)
- [MediaWiki Action API](https://www.mediawiki.org/wiki/API:Main_page)
- [LibriVox book 1837](https://librivox.org/celtic-fairy-tales-by-joseph-jacobs/)
- [LibriVox API record for book 1837](https://librivox.org/api/feed/audiobooks?id=1837&format=json&extended=1)
- [LibriVox API documentation](https://librivox.org/api/info)
- [LibriVox public-domain policy](https://librivox.org/pages/about-librivox/)
- [Project Gutenberg 7885](https://www.gutenberg.org/ebooks/7885)
- [LOC California Gold collection](https://www.loc.gov/collections/sidney-robertson-cowell-northern-california-folk-music/)
- [LOC California Gold rights and access](https://www.loc.gov/collections/sidney-robertson-cowell-northern-california-folk-music/about-this-collection/rights-and-access/)
- [LOC APIs](https://www.loc.gov/apis/)
- [Europeana APIs](https://api.europeana.eu/en)
