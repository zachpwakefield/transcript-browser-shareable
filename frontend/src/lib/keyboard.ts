export type BrowserKeyboardCommand =
  | "focus-search"
  | "next-transcript"
  | "previous-transcript"
  | "toggle-pin"
  | "focus-comparison"
  | "set-comparison"
  | "page-up"
  | "page-down"
  | "home"
  | "end";

export interface ShortcutGateInput {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  targetTag?: string;
  targetRole?: string;
  contentEditable?: boolean;
  blockedContext?: boolean;
  modalOpen?: boolean;
}

const TEXT_INPUT_TYPES = new Set(["input", "textarea", "select"]);

/** Pure shortcut gate shared by the global handler and unit tests. */
export function browserKeyboardCommand(input: ShortcutGateInput): BrowserKeyboardCommand | null {
  if (input.modalOpen || input.blockedContext || input.contentEditable) return null;
  if (TEXT_INPUT_TYPES.has((input.targetTag ?? "").toLowerCase())) return null;
  if ((input.targetRole ?? "").toLowerCase() === "textbox") return null;
  if (input.altKey || input.ctrlKey || input.metaKey) return null;

  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (key === "/" && !input.shiftKey) return "focus-search";
  if (key === "j" && !input.shiftKey) return "next-transcript";
  if (key === "k" && !input.shiftKey) return "previous-transcript";
  if (key === "p" && !input.shiftKey) return "toggle-pin";
  if (key === "c") return input.shiftKey ? "set-comparison" : "focus-comparison";
  if (key === "PageUp") return "page-up";
  if (key === "PageDown") return "page-down";
  if (key === "Home") return "home";
  if (key === "End") return "end";
  return null;
}
