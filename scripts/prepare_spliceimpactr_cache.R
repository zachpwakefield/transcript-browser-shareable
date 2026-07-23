#!/usr/bin/env Rscript

# Prepare the browser's portable annotation-cache contract with SpliceImpactR.
#
# The browser itself is offline once the SQLite build exists.  This script is
# the explicit, network-enabled preparation step: it obtains GENCODE v45
# assets through SpliceImpactR's cache machinery, queries the Ensembl 111 / ELM
# feature sources through SpliceImpactR, and writes the seven RDS files that
# backend/builder consumes.  No machine paths are written to the manifest.

options(stringsAsFactors = FALSE)

parse_args <- function(args) {
  out <- list()
  i <- 1L
  while (i <= length(args)) {
    key <- args[[i]]
    if (!startsWith(key, "--")) {
      stop("Arguments must use --name value (or a boolean --force).", call. = FALSE)
    }
    name <- substring(key, 3L)
    if (name %in% c("force", "skip-exon")) {
      out[[name]] <- TRUE
      i <- i + 1L
      next
    }
    if (i == length(args) || startsWith(args[[i + 1L]], "--")) {
      stop(paste0("Missing value for --", name), call. = FALSE)
    }
    out[[name]] <- args[[i + 1L]]
    i <- i + 2L
  }
  out
}

args <- parse_args(commandArgs(trailingOnly = TRUE))
get_arg <- function(name, default = NULL) {
  if (!is.null(args[[name]])) args[[name]] else default
}
required_arg <- function(name) {
  value <- get_arg(name)
  if (is.null(value) || !nzchar(value)) {
    stop(paste0("Missing required argument --", name), call. = FALSE)
  }
  value
}

if (!requireNamespace("SpliceImpactR", quietly = TRUE)) {
  stop(
    paste(
      "SpliceImpactR is not installed.",
      "Install the bundled source first with:",
      "R CMD INSTALL spliceimpactr/SpliceImpactR"
    ),
    call. = FALSE
  )
}
if (!requireNamespace("jsonlite", quietly = TRUE)) {
  stop("jsonlite is required to write the preparation manifest.", call. = FALSE)
}

output_dir <- normalizePath(required_arg("output"), winslash = "/", mustWork = FALSE)
base_dir <- normalizePath(
  get_arg("base-dir", file.path(output_dir, "..", "spliceimpactr-cache")),
  winslash = "/",
  mustWork = FALSE
)
dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
dir.create(base_dir, recursive = TRUE, showWarnings = FALSE)

gencode_release <- as.integer(get_arg("gencode-release", "45"))
ensembl_release <- as.integer(get_arg("ensembl-release", "111"))
if (!identical(gencode_release, 45L)) {
  stop("This browser contract is pinned to GENCODE v45.", call. = FALSE)
}
if (!identical(ensembl_release, 111L)) {
  stop("This browser contract is pinned to Ensembl release 111.", call. = FALSE)
}
filter_tsl <- strsplit(get_arg("filter-tsl", "1,2,3"), ",", fixed = TRUE)[[1L]]
filter_tsl <- trimws(filter_tsl[nzchar(trimws(filter_tsl))])
if (!length(filter_tsl) || any(!filter_tsl %in% as.character(seq_len(5L)))) {
  stop("--filter-tsl must be a comma-separated subset of 1,2,3,4,5.", call. = FALSE)
}
force <- isTRUE(args$force)

raw_names <- c(
  gtf = "gencode.v45.annotation.gtf.gz",
  transcript = "gencode.v45.pc_transcripts.fa.gz",
  translation = "gencode.v45.pc_translations.fa.gz"
)
explicit_raw <- c(
  gtf = if (is.null(get_arg("gtf"))) NA_character_ else get_arg("gtf"),
  transcript = if (is.null(get_arg("transcript-fa"))) NA_character_ else get_arg("transcript-fa"),
  translation = if (is.null(get_arg("protein-fa"))) NA_character_ else get_arg("protein-fa")
)

if (any(is.na(explicit_raw)) && any(!is.na(explicit_raw))) {
  stop("Provide all three of --gtf, --transcript-fa, and --protein-fa, or none.", call. = FALSE)
}

if (all(!is.na(explicit_raw))) {
  raw_paths <- setNames(
    vapply(explicit_raw, function(path) normalizePath(path, winslash = "/", mustWork = TRUE), character(1)),
    names(explicit_raw)
  )
} else {
  message("[1/3] Obtaining GENCODE v45 assets through SpliceImpactR's cache")
  # This helper is intentionally the only internal-package call.  The public
  # get_annotation()/get_protein_features() APIs do the actual parsing and
  # annotation work; the helper exposes the cached raw files so the Python
  # builder can consume the same authoritative inputs.
  assets <- SpliceImpactR:::.si_prepare_assets(
    base_dir = base_dir,
    species = "human",
    release = gencode_release,
    mode = "download"
  )
  raw_paths <- c(
    gtf = assets$paths$gtf_gz,
    transcript = assets$paths$txfa_gz,
    translation = assets$paths$aafa_gz
  )
}

for (key in names(raw_paths)) {
  if (!file.exists(raw_paths[[key]])) stop("Missing raw input: ", raw_paths[[key]], call. = FALSE)
  destination <- file.path(output_dir, raw_names[[key]])
  if (force || !file.exists(destination)) {
    ok <- file.copy(raw_paths[[key]], destination, overwrite = TRUE)
    if (!isTRUE(ok)) stop("Could not copy raw input to ", destination, call. = FALSE)
  }
}

message("[2/3] Processing GENCODE annotation with SpliceImpactR")
annotation <- SpliceImpactR::get_annotation(
  load = "path",
  base_dir = base_dir,
  species = "human",
  release = gencode_release,
  gtf_path = file.path(output_dir, raw_names[["gtf"]]),
  transcript_path = file.path(output_dir, raw_names[["transcript"]]),
  translation_path = file.path(output_dir, raw_names[["translation"]]),
  filter_tsl = filter_tsl
)

required_columns <- c(
  "ensembl_transcript_id", "start", "stop", "chr", "strand",
  "feature_id", "clean_name", "alt_name", "database",
  "ensembl_peptide_id", "method", "name"
)
sources <- c("interpro", "pfam", "cdd", "tmhmm", "signalp", "mobidblite", "elm")

validate_feature_table <- function(features, source) {
  features <- as.data.frame(features, stringsAsFactors = FALSE)
  missing <- setdiff(required_columns, names(features))
  if (length(missing)) {
    stop(source, " output is missing columns: ", paste(missing, collapse = ", "), call. = FALSE)
  }
  features[required_columns]
}

feature_summary <- list()
feature_tables <- list()
message("[3/3] Retrieving seven protein-feature sources (Ensembl ", ensembl_release, ")")
for (source in sources) {
  output_path <- file.path(output_dir, paste0(source, ".rds"))
  if (file.exists(output_path) && !force) {
    message("  [cache] ", source)
    features <- readRDS(output_path)
  } else {
    message("  [query] ", source)
    features <- SpliceImpactR::get_protein_features(
      biomaRt_databases = source,
      gtf_df = annotation$annotations,
      sequences = annotation$sequences,
      base_dir = base_dir,
      use_cache = TRUE,
      force_refresh = force,
      timeout = 600,
      species = "human",
      release = ensembl_release,
      test = FALSE,
      combine_overlaps = FALSE
    )
  }
  features <- validate_feature_table(features, source)
  saveRDS(features, output_path, compress = "xz")
  feature_tables[[source]] <- features
  feature_summary[[source]] <- list(
    file = paste0(source, ".rds"),
    rows = nrow(features),
    distinct_transcripts = length(unique(features$ensembl_transcript_id[!is.na(features$ensembl_transcript_id)])),
    distinct_feature_ids = length(unique(features$feature_id[!is.na(features$feature_id)]))
  )
}

exon_feature_path <- file.path(output_dir, "exon_features.rds")
if (file.exists(exon_feature_path) && !force) {
  message("  [cache] exon-level projections")
  exon_features <- readRDS(exon_feature_path)
} else if (isTRUE(args$`skip-exon`)) {
  exon_features <- NULL
} else {
  message("  [derive] exon-level projections")
  all_features <- do.call(rbind, feature_tables)
  exon_features <- SpliceImpactR::get_exon_features(
    annotation$annotations,
    all_features,
    inclusive = TRUE
  )
  saveRDS(exon_features, exon_feature_path, compress = "xz")
}

manifest <- list(
  schema = "transcript-browser-spliceimpactr-cache/v1",
  gencode_release = gencode_release,
  ensembl_release = ensembl_release,
  filter_tsl = filter_tsl,
  raw_inputs = unname(raw_names),
  feature_sources = feature_summary,
  exon_features = if (is.null(exon_features)) NULL else list(
    file = "exon_features.rds",
    rows = nrow(exon_features)
  ),
  producer = list(
    package = "SpliceImpactR",
    version = as.character(utils::packageVersion("SpliceImpactR")),
    package_license = "GPL-3"
  ),
  browser_contract = list(
    required_feature_columns = required_columns,
    output_directory = ".",
    note = "Paths are intentionally relative; raw files and RDS tables are local scientific inputs."
  )
)
jsonlite::write_json(
  manifest,
  file.path(output_dir, "spliceimpactr_manifest.json"),
  pretty = TRUE,
  auto_unbox = TRUE,
  null = "null"
)
message("Wrote browser inputs to: ", output_dir)
