#!/usr/bin/env Rscript

script_argument <- grep(
  "^--file=",
  commandArgs(trailingOnly = FALSE),
  value = TRUE
)
if (length(script_argument) != 1L) {
  stop("Cannot resolve the R exporter directory for dependency preflight.", call. = FALSE)
}
script_path <- normalizePath(sub("^--file=", "", script_argument[[1L]]), mustWork = TRUE)
script_directory <- dirname(script_path)
dependency_lock <- file.path(script_directory, "dependencies.lock.tsv")
renv_lock <- file.path(script_directory, "renv.lock")
source(file.path(script_directory, "preflight.R"), local = TRUE)
dependency_versions <- run_dependency_preflight(dependency_lock, renv_lock)

suppressPackageStartupMessages(library(data.table))
suppressPackageStartupMessages(library(jsonlite))

parse_args <- function(args) {
  result <- list()
  index <- 1L
  while (index <= length(args)) {
    key <- args[[index]]
    if (!startsWith(key, "--") || index == length(args)) {
      stop("Arguments must be provided as --key value pairs")
    }
    result[[substring(key, 3L)]] <- args[[index + 1L]]
    index <- index + 2L
  }
  result
}

args <- parse_args(commandArgs(trailingOnly = TRUE))
required_args <- c("input", "output", "transcripts")
missing_args <- required_args[!required_args %in% names(args)]
if (length(missing_args)) {
  stop(paste("Missing arguments:", paste(missing_args, collapse = ", ")))
}

dir.create(args$output, recursive = TRUE, showWarnings = FALSE)
transcript_ids <- fread(
  args$transcripts,
  header = FALSE,
  col.names = "transcript_id",
  colClasses = "character"
)$transcript_id

sources <- c(
  interpro = "interpro.rds",
  pfam = "pfam.rds",
  cdd = "cdd.rds",
  tmhmm = "tmhmm.rds",
  signalp = "signalp.rds",
  mobidblite = "mobidblite.rds",
  elm = "elm.rds"
)

required_columns <- c(
  "ensembl_transcript_id", "start", "stop", "chr", "strand",
  "feature_id", "clean_name", "alt_name", "database",
  "ensembl_peptide_id", "method", "name"
)

summary <- list()
for (source in names(sources)) {
  input_path <- file.path(args$input, sources[[source]])
  if (!file.exists(input_path)) {
    stop(paste("Missing feature input", input_path))
  }
  features <- as.data.table(readRDS(input_path))
  missing_columns <- setdiff(required_columns, names(features))
  if (length(missing_columns)) {
    stop(paste(
      basename(input_path), "is missing columns",
      paste(missing_columns, collapse = ", ")
    ))
  }
  features <- features[ensembl_transcript_id %chin% transcript_ids, ..required_columns]
  setorderv(features, required_columns, na.last = TRUE)
  output_path <- file.path(args$output, paste0(source, ".tsv"))
  fwrite(features, output_path, sep = "\t", quote = TRUE, na = "")
  summary[[source]] <- list(
    source_file = sources[[source]],
    rows = nrow(features),
    distinct_transcripts = uniqueN(features$ensembl_transcript_id),
    distinct_feature_ids = uniqueN(features$feature_id, na.rm = TRUE),
    output_file = basename(output_path)
  )
}

write_json(
  list(
    exporter = "R/data.table",
    r_version = R.version.string,
    supported_r_version = SUPPORTED_R_VERSION,
    dependency_lock = basename(dependency_lock),
    renv_lock = basename(renv_lock),
    data_table_version = unname(dependency_versions[["data.table"]]),
    jsonlite_version = unname(dependency_versions[["jsonlite"]]),
    dependencies = as.list(dependency_versions),
    sources = summary
  ),
  file.path(args$output, "feature_export_manifest.json"),
  pretty = TRUE,
  auto_unbox = TRUE
)
