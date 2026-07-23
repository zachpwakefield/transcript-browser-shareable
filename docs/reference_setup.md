# Optional whole-genome reference setup

The transcript, transcript-sequence, and protein-feature browser does not need a whole-genome reference. Add this optional input only when you want the API to serve verified byte ranges from an Ensembl GRCh38.p14 FASTA.

Use the Ensembl release-115 file paired with GENCODE v45/Ensembl 111, then create the checksum-compatible FAI index (for example, with `samtools faidx`):

```bash
mkdir -p data/reference
# download the official release-115 Homo_sapiens.GRCh38.dna.toplevel.fa.gz
gunzip -c Homo_sapiens.GRCh38.dna.toplevel.fa.gz > data/reference/Homo_sapiens.GRCh38.dna.toplevel.fa
samtools faidx data/reference/Homo_sapiens.GRCh38.dna.toplevel.fa
shasum -a 256 data/reference/Homo_sapiens.GRCh38.dna.toplevel.fa
shasum -a 256 data/reference/Homo_sapiens.GRCh38.dna.toplevel.fa.fai
```

The expected SHA-256 values are constants in `backend/builder/constants.py`. When `--reference-fasta` is supplied, the builder checks the FASTA, FAI, primary-contig lengths, chromosome aliases, and GENCODE/Ensembl release lineage. Do not edit a generated manifest or substitute a different assembly to bypass a failed check.

The FASTA is a local scientific input and is ignored by Git. Keep it in `data/reference/` or pass an equivalent path explicitly to `scripts/build_annotations.sh --reference-fasta`. If it is omitted, run `scripts/build_annotations.sh data/cache --scope full` and the browser will start in transcript-package-only mode with reference-range endpoints unavailable.
