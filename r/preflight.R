SUPPORTED_R_VERSION <- "4.5.2"

assert_supported_r_version <- function(expected = SUPPORTED_R_VERSION) {
  actual <- as.character(getRversion())
  if (!identical(actual, expected)) {
    stop(
      paste0(
        "Unsupported R runtime: expected ", expected, "; found ", actual, ".\n",
        "Install the pinned R release or run the build in that environment."
      ),
      call. = FALSE
    )
  }
  actual
}

read_dependency_lock <- function(lock_path) {
  if (!file.exists(lock_path)) {
    stop(
      paste("R dependency lock is missing:", normalizePath(lock_path, mustWork = FALSE)),
      call. = FALSE
    )
  }
  lock <- read.delim(
    lock_path,
    header = TRUE,
    colClasses = "character",
    stringsAsFactors = FALSE,
    check.names = FALSE
  )
  if (!identical(names(lock), c("package", "version")) || !nrow(lock)) {
    stop(
      "R dependency lock must contain non-empty package and version columns.",
      call. = FALSE
    )
  }
  if (any(!nzchar(lock$package)) || any(!nzchar(lock$version))) {
    stop("R dependency lock contains an empty package or version.", call. = FALSE)
  }
  if (anyDuplicated(lock$package)) {
    stop("R dependency lock contains duplicate package names.", call. = FALSE)
  }
  lock
}

validate_renv_lock <- function(renv_lock_path, dependency_lock) {
  if (!file.exists(renv_lock_path)) {
    stop(
      paste("renv lock is missing:", normalizePath(renv_lock_path, mustWork = FALSE)),
      call. = FALSE
    )
  }
  if (!requireNamespace("jsonlite", quietly = TRUE)) {
    stop("jsonlite is required to validate renv.lock.", call. = FALSE)
  }
  lock <- jsonlite::fromJSON(renv_lock_path, simplifyVector = FALSE)
  if (is.null(lock$R$Version) || !identical(lock$R$Version, SUPPORTED_R_VERSION)) {
    stop(
      paste0(
        "renv.lock R version mismatch: expected ", SUPPORTED_R_VERSION,
        "; found ", lock$R$Version %||% "<missing>"
      ),
      call. = FALSE
    )
  }
  for (index in seq_len(nrow(dependency_lock))) {
    package <- dependency_lock$package[[index]]
    expected <- dependency_lock$version[[index]]
    record <- lock$Packages[[package]]
    if (is.null(record) || is.null(record$Version) || !identical(record$Version, expected)) {
      found <- if (is.null(record) || is.null(record$Version)) "<missing>" else record$Version
      stop(
        paste0(
          "renv.lock package mismatch for ", package, ": expected ", expected,
          "; found ", found
        ),
        call. = FALSE
      )
    }
  }
  invisible(TRUE)
}

`%||%` <- function(left, right) if (is.null(left)) right else left

run_dependency_preflight <- function(lock_path, renv_lock_path = NULL) {
  assert_supported_r_version()
  lock <- read_dependency_lock(lock_path)
  actual <- setNames(rep(NA_character_, nrow(lock)), lock$package)
  problems <- character()

  for (index in seq_len(nrow(lock))) {
    package <- lock$package[[index]]
    expected <- lock$version[[index]]
    if (!requireNamespace(package, quietly = TRUE)) {
      problems <- c(
        problems,
        sprintf("- %s: expected %s; package is not installed", package, expected)
      )
      next
    }
    installed <- as.character(packageVersion(package))
    actual[[package]] <- installed
    if (!identical(installed, expected)) {
      problems <- c(
        problems,
        sprintf("- %s: expected %s; found %s", package, expected, installed)
      )
    }
  }

  if (length(problems)) {
    specifications <- paste0(lock$package, "@", lock$version, collapse = "\", \"")
    remediation <- paste0(
      "Rscript -e 'if (!requireNamespace(\"renv\", quietly=TRUE)) ",
      "install.packages(\"renv\"); renv::install(c(\"",
      specifications,
      "\"))'"
    )
    stop(
      paste(
        "Pinned R dependency preflight failed.",
        paste(problems, collapse = "\n"),
        paste("Lock:", normalizePath(lock_path, mustWork = TRUE)),
        paste("Restore the exact versions, then rerun the build:\n", remediation),
        sep = "\n"
      ),
      call. = FALSE
    )
  }

  if (!is.null(renv_lock_path)) {
    validate_renv_lock(renv_lock_path, lock)
  }

  actual
}
