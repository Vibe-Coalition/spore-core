"use client";

import {
  createContext,
  useContext,
  useReducer,
  useEffect,
  ReactNode,
} from "react";

// --- Favorites ---

type FavAction =
  | { type: "add"; id: string }
  | { type: "remove"; id: string }
  | { type: "toggle"; id: string }
  | { type: "load"; ids: string[] };

function favReducer(state: string[], action: FavAction): string[] {
  switch (action.type) {
    case "add":
      return state.includes(action.id) ? state : [...state, action.id];
    case "remove":
      return state.filter((id) => id !== action.id);
    case "toggle":
      return state.includes(action.id)
        ? state.filter((id) => id !== action.id)
        : [...state, action.id];
    case "load":
      return action.ids;
    default:
      return state;
  }
}

const FavContext = createContext<{
  favorites: string[];
  dispatch: React.Dispatch<FavAction>;
} | null>(null);

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const [favorites, dispatch] = useReducer(favReducer, []);

  useEffect(() => {
    const raw = localStorage.getItem("cat-favorites");
    if (raw) dispatch({ type: "load", ids: JSON.parse(raw) });
  }, []);

  useEffect(() => {
    localStorage.setItem("cat-favorites", JSON.stringify(favorites));
  }, [favorites]);

  return (
    <FavContext.Provider value={{ favorites, dispatch }}>
      {children}
    </FavContext.Provider>
  );
}

export function useFavorites() {
  const ctx = useContext(FavContext);
  if (!ctx) throw new Error("useFavorites must be in FavoritesProvider");
  return ctx;
}

// --- Comparison ---

const MAX_COMPARE = 2;

type CmpAction =
  | { type: "add"; id: string }
  | { type: "remove"; id: string }
  | { type: "toggle"; id: string }
  | { type: "clear" }
  | { type: "load"; ids: string[] };

function cmpReducer(state: string[], action: CmpAction): string[] {
  switch (action.type) {
    case "add":
      if (state.includes(action.id)) return state;
      if (state.length >= MAX_COMPARE) return [state[1], action.id];
      return [...state, action.id];
    case "remove":
      return state.filter((id) => id !== action.id);
    case "toggle": {
      const exists = state.includes(action.id);
      if (exists) return state.filter((id) => id !== action.id);
      if (state.length >= MAX_COMPARE) return [state[1], action.id];
      return [...state, action.id];
    }
    case "clear":
      return [];
    case "load":
      return action.ids.slice(0, MAX_COMPARE);
    default:
      return state;
  }
}

const CmpContext = createContext<{
  compare: string[];
  dispatch: React.Dispatch<CmpAction>;
} | null>(null);

export function CompareProvider({ children }: { children: ReactNode }) {
  const [compare, dispatch] = useReducer(cmpReducer, []);

  useEffect(() => {
    const raw = localStorage.getItem("cat-compare");
    if (raw) dispatch({ type: "load", ids: JSON.parse(raw) });
  }, []);

  useEffect(() => {
    localStorage.setItem("cat-compare", JSON.stringify(compare));
  }, [compare]);

  return (
    <CmpContext.Provider value={{ compare, dispatch }}>
      {children}
    </CmpContext.Provider>
  );
}

export function useCompare() {
  const ctx = useContext(CmpContext);
  if (!ctx) throw new Error("useCompare must be in CompareProvider");
  return ctx;
}
