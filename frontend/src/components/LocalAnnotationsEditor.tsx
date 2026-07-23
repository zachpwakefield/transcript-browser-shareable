import { useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_NOTE_CHARACTERS,
  MAX_TAG_CHARACTERS,
  MAX_TAGS_PER_ENTITY,
  createUserAnnotation,
  parseEntityKey,
  type EntityKey,
  type UserAnnotation,
} from "../lib/workspaceStore";

export const ANNOTATION_AUTOSAVE_DELAY_MS = 500;

export type AnnotationEditorStatus =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "invalid"
  | "deleting"
  | "deleted"
  | "error";

export interface AnnotationValidationResult {
  valid: boolean;
  errors: string[];
  annotation?: UserAnnotation;
}

export interface LocalAnnotationsEditorProps {
  entityKey: EntityKey;
  entityLabel: string;
  note: string;
  tags: readonly string[];
  hasSavedAnnotation: boolean;
  updatedAt?: string;
  onNoteChange: (note: string) => void;
  onTagsChange: (tags: string[]) => void;
  onSave: (entityKey: EntityKey, annotation: UserAnnotation) => void | Promise<void>;
  onDelete: (entityKey: EntityKey) => void | Promise<void>;
  ariaLabel?: string;
}

function characterCount(value: string): number {
  return [...value].length;
}

function annotationSignature(annotation: Pick<UserAnnotation, "note" | "tags">): string {
  return JSON.stringify([annotation.note, annotation.tags]);
}

export function validateLocalAnnotationDraft(
  entityKey: EntityKey,
  note: string,
  tags: readonly string[],
): AnnotationValidationResult {
  const errors: string[] = [];
  if (!parseEntityKey(entityKey)) errors.push("A valid gene or transcript is required.");
  const noteLength = characterCount(note);
  if (noteLength > MAX_NOTE_CHARACTERS) {
    errors.push(`Note exceeds the ${MAX_NOTE_CHARACTERS.toLocaleString()}-character limit.`);
  }
  if (tags.length > MAX_TAGS_PER_ENTITY) {
    errors.push(`Use at most ${MAX_TAGS_PER_ENTITY} tags.`);
  }
  const seen = new Set<string>();
  tags.forEach((rawTag, index) => {
    const tag = rawTag.trim();
    const normalized = tag.toLocaleLowerCase();
    if (!tag) errors.push(`Tag ${index + 1} is empty.`);
    else if (characterCount(tag) > MAX_TAG_CHARACTERS) {
      errors.push(`Tag ${index + 1} exceeds the ${MAX_TAG_CHARACTERS}-character limit.`);
    } else if (seen.has(normalized)) errors.push(`Tag ${index + 1} duplicates another tag.`);
    else seen.add(normalized);
  });
  if (errors.length) return { valid: false, errors };
  try {
    return { valid: true, errors: [], annotation: createUserAnnotation(note, tags) };
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : "The local annotation is invalid."],
    };
  }
}

function statusMessage(status: AnnotationEditorStatus): string {
  if (status === "pending") return "Changes pending; autosave starts after 500 milliseconds.";
  if (status === "saving") return "Saving annotation to the local workspace…";
  if (status === "saved") return "Annotation saved locally.";
  if (status === "invalid") return "Annotation has validation errors and was not saved.";
  if (status === "deleting") return "Deleting the local annotation…";
  if (status === "deleted") return "Local annotation deleted.";
  if (status === "error") return "The local workspace operation failed.";
  return "No unsaved annotation changes.";
}

/** Controlled note/tag editor with bounded, callback-only local persistence. */
export function LocalAnnotationsEditor({
  entityKey,
  entityLabel,
  note,
  tags,
  hasSavedAnnotation,
  updatedAt,
  onNoteChange,
  onTagsChange,
  onSave,
  onDelete,
  ariaLabel = "Local notes and tags",
}: LocalAnnotationsEditorProps) {
  const validation = useMemo(
    () => validateLocalAnnotationDraft(entityKey, note, tags),
    [entityKey, note, tags],
  );
  const normalizedSignature = validation.annotation
    ? annotationSignature(validation.annotation)
    : JSON.stringify([note, tags]);
  const [status, setStatus] = useState<AnnotationEditorStatus>("idle");
  const [operationError, setOperationError] = useState<string>();
  const [newTag, setNewTag] = useState("");
  const [newTagError, setNewTagError] = useState<string>();
  const lastSavedSignature = useRef(normalizedSignature);
  const operationSequence = useRef(0);
  const autosaveTimer = useRef<number | undefined>(undefined);
  const saveCallback = useRef(onSave);
  const deleteCallback = useRef(onDelete);
  saveCallback.current = onSave;
  deleteCallback.current = onDelete;

  useEffect(() => {
    operationSequence.current += 1;
    if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = undefined;
    lastSavedSignature.current = normalizedSignature;
    setStatus("idle");
    setOperationError(undefined);
    setNewTag("");
    setNewTagError(undefined);
  // The current normalized draft becomes the baseline only when the entity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityKey]);

  useEffect(() => {
    operationSequence.current += 1;
    const sequence = operationSequence.current;
    if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = undefined;
    setOperationError(undefined);

    if (!validation.valid || !validation.annotation) {
      setStatus("invalid");
      return;
    }
    if (normalizedSignature === lastSavedSignature.current) {
      setStatus((current) => current === "saved" || current === "deleted" ? current : "idle");
      return;
    }

    const annotation = validation.annotation;
    setStatus("pending");
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = undefined;
      if (sequence !== operationSequence.current) return;
      setStatus("saving");
      void Promise.resolve()
        .then(() => saveCallback.current(entityKey, annotation))
        .then(() => {
          if (sequence !== operationSequence.current) return;
          lastSavedSignature.current = annotationSignature(annotation);
          setStatus("saved");
        })
        .catch((error: unknown) => {
          if (sequence !== operationSequence.current) return;
          setOperationError(error instanceof Error ? error.message : "Unable to save the local annotation.");
          setStatus("error");
        });
    }, ANNOTATION_AUTOSAVE_DELAY_MS);

    return () => {
      if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current);
      autosaveTimer.current = undefined;
      operationSequence.current += 1;
    };
  }, [entityKey, normalizedSignature, validation.valid]);

  function addTag() {
    const tag = newTag.trim();
    if (!tag) {
      setNewTagError("Enter a tag before adding it.");
      return;
    }
    const candidate = validateLocalAnnotationDraft(entityKey, note, [...tags, tag]);
    if (!candidate.valid || !candidate.annotation) {
      setNewTagError(candidate.errors[0] ?? "That tag cannot be added.");
      return;
    }
    onTagsChange(candidate.annotation.tags);
    setNewTag("");
    setNewTagError(undefined);
  }

  function deleteAnnotation() {
    if (!hasSavedAnnotation) return;
    const priorSignature = lastSavedSignature.current;
    const empty = createUserAnnotation("", []);
    operationSequence.current += 1;
    const sequence = operationSequence.current;
    if (autosaveTimer.current !== undefined) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = undefined;
    // Prevent a controlled parent clearing the fields after deletion from
    // immediately recreating an empty annotation through autosave.
    lastSavedSignature.current = annotationSignature(empty);
    setOperationError(undefined);
    setStatus("deleting");
    void Promise.resolve()
      .then(() => deleteCallback.current(entityKey))
      .then(() => {
        if (sequence === operationSequence.current) setStatus("deleted");
      })
      .catch((error: unknown) => {
        if (sequence !== operationSequence.current) return;
        lastSavedSignature.current = priorSignature;
        setOperationError(error instanceof Error ? error.message : "Unable to delete the local annotation.");
        setStatus("error");
      });
  }

  const noteLength = characterCount(note);
  return (
    <section
      className="local-annotations-editor"
      aria-label={ariaLabel}
      data-entity-key={entityKey}
      data-annotation-status={status}
    >
      <header>
        <div>
          <span>Local annotation</span>
          <h3>{entityLabel}</h3>
          <code>{entityKey}</code>
        </div>
        {updatedAt && <time dateTime={updatedAt}>Last saved {updatedAt}</time>}
      </header>
      <p className="local-annotation-boundary">Private, build-scoped user content. It is never presented as GENCODE, Ensembl, or protein-feature evidence.</p>

      <label className="local-annotation-note">
        <span>Local user note</span>
        <textarea
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          aria-invalid={noteLength > MAX_NOTE_CHARACTERS}
          rows={5}
          placeholder="Add private, build-scoped interpretation or review context"
        />
        <small>{noteLength.toLocaleString()} / {MAX_NOTE_CHARACTERS.toLocaleString()} characters</small>
      </label>

      <fieldset className="local-annotation-tags">
        <legend>Local user tags <small>{tags.length} / {MAX_TAGS_PER_ENTITY}</small></legend>
        {tags.length ? (
          <ul>
            {tags.map((tag, index) => (
              <li key={index}>
                <input
                  value={tag}
                  onChange={(event) => {
                    const next = [...tags];
                    next[index] = event.target.value;
                    onTagsChange(next);
                  }}
                  aria-label={`Tag ${index + 1}`}
                  aria-invalid={!tag.trim() || characterCount(tag.trim()) > MAX_TAG_CHARACTERS}
                />
                <small>{characterCount(tag.trim())} / {MAX_TAG_CHARACTERS}</small>
                <button
                  type="button"
                  onClick={() => onTagsChange(tags.filter((_, tagIndex) => tagIndex !== index))}
                  aria-label={`Remove tag ${tag || index + 1}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : <p>No tags added.</p>}
        <div className="local-annotation-add-tag">
          <label>
            <span>New tag</span>
            <input
              value={newTag}
              onChange={(event) => {
                setNewTag(event.target.value);
                setNewTagError(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addTag();
              }}
              disabled={tags.length >= MAX_TAGS_PER_ENTITY}
              aria-invalid={Boolean(newTagError)}
            />
          </label>
          <button
            type="button"
            onClick={addTag}
            disabled={tags.length >= MAX_TAGS_PER_ENTITY}
          >
            Add tag
          </button>
        </div>
        {newTagError && <p className="local-annotation-tag-error" role="alert">{newTagError}</p>}
      </fieldset>

      {!validation.valid && (
        <ul className="local-annotation-errors" role="alert">
          {validation.errors.map((error) => <li key={error}>{error}</li>)}
        </ul>
      )}
      {operationError && <p className="local-annotation-operation-error" role="alert">{operationError}</p>}
      <div className="local-annotation-status" role="status" aria-live="polite" aria-atomic="true">
        {statusMessage(status)}
      </div>

      <div className="local-annotation-actions">
        <button
          type="button"
          className="local-annotation-delete"
          disabled={!hasSavedAnnotation || status === "deleting"}
          onClick={deleteAnnotation}
          aria-label={`Delete local annotation for ${entityLabel}`}
        >
          {status === "deleting" ? "Deleting…" : "Delete annotation"}
        </button>
      </div>
    </section>
  );
}

export default LocalAnnotationsEditor;
