import type { GenomicSegment, Transcript, TranscriptExon } from "../types";

function translatedCdsExons(transcript: Transcript): TranscriptExon[] {
  return transcript.exons
    .filter(
      (item): item is TranscriptExon & { cdsStart0: number; cdsEnd0: number } =>
        item.cdsStart0 !== undefined && item.cdsEnd0 !== undefined,
    )
    // GTF exon_number/rank is already transcript 5′→3′ order on both strands.
    .sort((left, right) => left.rank - right.rank);
}

/**
 * Project a verified, 1-based inclusive amino-acid interval through ordered
 * GTF CDS segments. Raw genomic bounding spans from feature RDS names are
 * deliberately not accepted by this function.
 */
export function projectFeatureThroughCds(
  transcript: Transcript,
  aaStart: number,
  aaEnd: number,
): GenomicSegment[] {
  if (
    !Number.isInteger(aaStart) ||
    !Number.isInteger(aaEnd) ||
    aaStart < 1 ||
    aaEnd < aaStart ||
    aaEnd > transcript.proteinLength
  ) {
    return [];
  }
  const featureStartNt = (aaStart - 1) * 3;
  const featureEndNt = aaEnd * 3;
  let transcriptOffset = 0;
  const segments: GenomicSegment[] = [];

  for (const item of translatedCdsExons(transcript)) {
    const cdsStart0 = item.cdsStart0 as number;
    const cdsEnd0 = item.cdsEnd0 as number;
    const segmentLength = cdsEnd0 - cdsStart0;
    const offsetStart = transcriptOffset;
    const offsetEnd = offsetStart + segmentLength;
    const overlapStart = Math.max(featureStartNt, offsetStart);
    const overlapEnd = Math.min(featureEndNt, offsetEnd);

    if (overlapEnd > overlapStart) {
      if (transcript.strand === "+") {
        segments.push({
          start0: cdsStart0 + (overlapStart - offsetStart),
          end0: cdsStart0 + (overlapEnd - offsetStart),
          exonRank: item.rank,
        });
      } else {
        segments.push({
          start0: cdsEnd0 - (overlapEnd - offsetStart),
          end0: cdsEnd0 - (overlapStart - offsetStart),
          exonRank: item.rank,
        });
      }
    }
    transcriptOffset = offsetEnd;
    if (transcriptOffset >= featureEndNt) break;
  }
  const expectedCoverage = (aaEnd - aaStart + 1) * 3;
  const observedCoverage = segments.reduce(
    (total, segment) => total + segment.end0 - segment.start0,
    0,
  );
  return observedCoverage === expectedCoverage ? segments : [];
}
