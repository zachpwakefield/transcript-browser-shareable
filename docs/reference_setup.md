# Reference setup

The browser needs a local, uncompressed Ensembl GRCh38.p14 top-level FASTA and its `.fai` index. Use the Ensembl release-115 file paired with GENCODE v45/Ensembl 111, then verify the bytes before building:

```bash
mkdir -p data/reference
# download the official release-115 Homo_sapiens.GRCh38.dna.toplevel.fa.gz
gunzip -c Homo_sapiens.GRCh38.dna.toplevel.fa.gz > data/reference/Homo_sapiens.GRCh38.dna.toplevel.fa
samtools faidx data/reference/Homo_sapiens.GRCh38.dna.toplevel.fa
shasum -a 256 data/reference/Homo_sapiens.GRCh38.dna.toplevel.fa
shasum -a 256 data/reference/Homo_sapiens.GRCh38.dna.toplevel.fa.fai
```

The expected SHA-256 values are constants in `backend/builder/constants.py`. The builder also checks primary-contig lengths, chromosome aliases, and the GENCODE/Ensembl release lineage. Do not edit a generated manifest or substitute a different assembly to bypass a failed check.

The FASTA is a local scientific input and is ignored by Git. Keep it in `data/reference/` or pass an equivalent path explicitly to `scripts/build_annotations.sh --reference-fasta`.
