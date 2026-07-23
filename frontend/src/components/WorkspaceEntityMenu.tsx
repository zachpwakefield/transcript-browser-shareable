import { useId, useMemo } from "react";
import {
  MAX_FAVORITES,
  MAX_RECENTS,
  entityReferenceKey,
  type EntityReference,
} from "../lib/workspaceStore";

export interface WorkspaceEntityMenuProps {
  recents: readonly EntityReference[];
  favorites: readonly EntityReference[];
  currentGene?: EntityReference;
  currentTranscript?: EntityReference;
  onNavigateEntity: (reference: EntityReference) => void;
  onToggleFavorite: (reference: EntityReference) => void;
  ariaLabel?: string;
}

interface EntityRowProps {
  reference: EntityReference;
  context: "favorite" | "recent";
  favorite: boolean;
  onNavigateEntity: (reference: EntityReference) => void;
  onToggleFavorite: (reference: EntityReference) => void;
}

function referenceIdentity(reference: EntityReference): string {
  return reference.versionedId ?? reference.id;
}

function EntityRow({
  reference,
  context,
  favorite,
  onNavigateEntity,
  onToggleFavorite,
}: EntityRowProps) {
  const identity = referenceIdentity(reference);
  return (
    <li className={`workspace-entity-row ${reference.kind}`} data-entity-key={entityReferenceKey(reference)}>
      <button
        type="button"
        className="workspace-entity-open"
        onClick={() => onNavigateEntity(reference)}
        aria-label={`Open ${context} ${reference.kind} ${reference.label}, ${identity}`}
      >
        <span className="workspace-entity-kind">{reference.kind}</span>
        <span className="workspace-entity-copy">
          <strong>{reference.label}</strong>
          <small>{identity}{reference.geneSymbol && reference.kind === "transcript" ? ` · ${reference.geneSymbol}` : ""}</small>
        </span>
      </button>
      <button
        type="button"
        className="workspace-entity-favorite"
        aria-pressed={favorite}
        aria-label={`${favorite ? "Remove" : "Add"} ${reference.label} ${reference.kind} ${favorite ? "from" : "to"} favorites`}
        title={favorite ? "Remove from favorites" : "Add to favorites"}
        onClick={() => onToggleFavorite(reference)}
      >
        <span aria-hidden="true">{favorite ? "★" : "☆"}</span>
      </button>
    </li>
  );
}

/** Native-details menu suitable for placement beside the search command. */
export function WorkspaceEntityMenu({
  recents,
  favorites,
  currentGene,
  currentTranscript,
  onNavigateEntity,
  onToggleFavorite,
  ariaLabel = "Recent and favorite local entities",
}: WorkspaceEntityMenuProps) {
  const currentHeadingId = useId();
  const favoritesHeadingId = useId();
  const recentsHeadingId = useId();
  const boundedFavorites = useMemo(() => favorites.slice(0, MAX_FAVORITES), [favorites]);
  const boundedRecents = useMemo(() => recents.slice(0, MAX_RECENTS), [recents]);
  const favoriteKeys = useMemo(
    () => new Set(boundedFavorites.map(entityReferenceKey)),
    [boundedFavorites],
  );
  const isFavorite = (reference: EntityReference | undefined) => (
    reference ? favoriteKeys.has(entityReferenceKey(reference)) : false
  );

  return (
    <details
      className="workspace-entity-menu"
      aria-label={ariaLabel}
      data-favorite-count={boundedFavorites.length}
      data-recent-count={boundedRecents.length}
    >
      <summary>
        <span>Workspace</span>
        <small>{boundedFavorites.length} favorites · {boundedRecents.length} recent</small>
      </summary>

      <div className="workspace-entity-menu-panel">
        <section className="workspace-current-entities" aria-labelledby={currentHeadingId}>
          <h2 id={currentHeadingId}>Current selection</h2>
          <div role="group" aria-label="Favorite current entities">
            {currentGene ? (
              <button
                type="button"
                aria-pressed={isFavorite(currentGene)}
                onClick={() => onToggleFavorite(currentGene)}
                aria-label={`${isFavorite(currentGene) ? "Remove" : "Add"} current gene ${currentGene.label} ${isFavorite(currentGene) ? "from" : "to"} favorites`}
              >
                <span aria-hidden="true">{isFavorite(currentGene) ? "★" : "☆"}</span>
                Gene · {currentGene.label}
              </button>
            ) : <span className="workspace-entity-empty">No current gene</span>}
            {currentTranscript ? (
              <button
                type="button"
                aria-pressed={isFavorite(currentTranscript)}
                onClick={() => onToggleFavorite(currentTranscript)}
                aria-label={`${isFavorite(currentTranscript) ? "Remove" : "Add"} current transcript ${currentTranscript.label} ${isFavorite(currentTranscript) ? "from" : "to"} favorites`}
              >
                <span aria-hidden="true">{isFavorite(currentTranscript) ? "★" : "☆"}</span>
                Transcript · {currentTranscript.label}
              </button>
            ) : <span className="workspace-entity-empty">No current transcript</span>}
          </div>
        </section>

        <section className="workspace-favorites" aria-labelledby={favoritesHeadingId}>
          <h2 id={favoritesHeadingId}>Favorites</h2>
          {boundedFavorites.length ? (
            <ul>
              {boundedFavorites.map((reference) => (
                <EntityRow
                  reference={reference}
                  context="favorite"
                  favorite
                  onNavigateEntity={onNavigateEntity}
                  onToggleFavorite={onToggleFavorite}
                  key={entityReferenceKey(reference)}
                />
              ))}
            </ul>
          ) : <p className="workspace-entity-empty">No favorite genes or transcripts yet.</p>}
        </section>

        <section className="workspace-recents" aria-labelledby={recentsHeadingId}>
          <h2 id={recentsHeadingId}>Recent</h2>
          {boundedRecents.length ? (
            <ul>
              {boundedRecents.map((reference) => (
                <EntityRow
                  reference={reference}
                  context="recent"
                  favorite={favoriteKeys.has(entityReferenceKey(reference))}
                  onNavigateEntity={onNavigateEntity}
                  onToggleFavorite={onToggleFavorite}
                  key={entityReferenceKey(reference)}
                />
              ))}
            </ul>
          ) : <p className="workspace-entity-empty">No recently opened genes or transcripts.</p>}
        </section>
      </div>
    </details>
  );
}

export default WorkspaceEntityMenu;
