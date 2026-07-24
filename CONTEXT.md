# Folklore Corpus

This context describes how captured source material becomes citable folklore
evidence without collapsing sources, interpretations, and inferred
relationships into one undifferentiated record.

## Source evidence

**Archive**:
An institution, collection, repository, or other origin from which source
material is obtained.
_Avoid_: Provider, website

**Source Item**:
An archive's own identifiable unit, preserved with its native identifier and
metadata.
_Avoid_: Story, record

**Capture**:
An immutable retrieval event for a Source Item, including when, where, and how
its exact bytes were obtained.
_Avoid_: Download, current copy

**Artifact**:
An immutable byte-bearing object identified by its content digest, whether
captured or derived.
_Avoid_: File, blob

**Edition**:
A published or assembled source context that explains why a set of Documents
appears together and who edited, translated, collected, or issued it.
_Avoid_: Dataset, collection

**Document**:
A source-defined subdivision of an Edition. A Document is not assumed to be a
unique traditional story or an original composition.
_Avoid_: Tale, work

**Witness**:
A specific attested text, recording, performance, image, or transcription as
it appears in source evidence.
_Avoid_: Canonical story, variant

**Representation**:
An immutable captured or derived rendition of a Witness, such as a scan, OCR
text, transcript, or translation.
_Avoid_: Current text, corrected file

**Passage**:
A stable citable part of a Witness anchored by source structure when possible.
Each Representation locates it with explicit text, page, image, or time
coordinates.
_Avoid_: Chunk

## Interpretation

**Claim**:
A versioned assertion about one or more corpus resources, attributed to a
person, project, model, or import method and supported by Evidence.
_Avoid_: Fact, tag

**Evidence**:
The corpus resources and precise selectors that support or contradict a Claim.
_Avoid_: Citation

**Derivation**:
A recorded transformation from immutable input resources to immutable output
resources, including the method and method version.
_Avoid_: Processing, lineage record

**Story Family**:
A proposed grouping of related Witnesses. Membership is expressed through
Claims and may be disputed or revised.
_Avoid_: Canonical story, duplicate group

**Cultural Context**:
An evidenced attribution of a Witness or practice to a place, language,
community, period, collector, or tradition.
_Avoid_: Culture field, origin

## Publication

**Release**:
An immutable, versioned selection of corpus resources plus a manifest that
pins their identities and digests.
_Avoid_: Export, latest dataset

**Projection**:
A rebuildable view of corpus resources optimized for a purpose such as search,
graph traversal, analysis, or model training.
_Avoid_: Source of truth
