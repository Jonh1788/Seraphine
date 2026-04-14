# Seraphine Design System

## Brand

**Seraphine** is a personal AI assistant. The visual identity communicates intelligence, elegance, and approachability through a premium dark theme with purple accents.

- **Logo**: Gradient text "Seraphine" (`--accent-gradient`)
- **Personality**: Warm but capable. Sophisticated but not cold.
- **Tone**: Dark, deep surfaces with luminous accents.

---

## Color Tokens

### Backgrounds (layered surfaces)
| Token | Value | Usage |
|-------|-------|-------|
| `--bg-0` | `#08080d` | App base, deepest layer |
| `--bg-1` | `#11111a` | Cards, panels, surfaces |
| `--bg-2` | `#1a1a28` | Elevated surfaces, inputs |
| `--bg-3` | `#232336` | Highest elevation, hover states |

### Text
| Token | Value | Usage |
|-------|-------|-------|
| `--text` | `#f0f0f8` | Primary text, headings |
| `--text-dim` | `#8888a0` | Secondary text, labels |
| `--text-faint` | `#555570` | Tertiary, placeholders, disabled |

### Accent (Purple family)
| Token | Value | Usage |
|-------|-------|-------|
| `--accent` | `#a78bfa` | Primary accent, links, active states |
| `--accent-hi` | `#c4b5fd` | Bright accent, hover |
| `--accent-dim` | `#6d52d8` | Dark accent, pressed states |
| `--accent-gradient` | `135deg #a78bfa → #6366f1 → #818cf8` | Buttons, brand text, highlights |
| `--accent-glow` | `0 0 20px rgba(167,139,250,0.15)` | Focus rings, elevated buttons |

### Semantic Colors
| Token | Value | Usage |
|-------|-------|-------|
| `--user` | `#4ade80` | User messages, income, success |
| `--danger` | `#ef4444` | Errors, expense, destructive |
| `--warning` | `#f59e0b` | Warnings, pending states |

### Borders
| Token | Value | Usage |
|-------|-------|-------|
| `--border` | `rgba(255,255,255,0.06)` | Subtle dividers |
| `--border-strong` | `rgba(255,255,255,0.1)` | Visible borders |
| `--glass-border` | `rgba(255,255,255,0.08)` | Glass surface borders |

---

## Glass Effect System

Used for elevated surfaces that need depth (topbar, composer, modals):

```css
background: var(--glass-bg);        /* rgba(17, 17, 26, 0.7) */
backdrop-filter: var(--glass-blur);  /* blur(16px) */
-webkit-backdrop-filter: var(--glass-blur);
border: 1px solid var(--glass-border);
```

---

## Spacing Scale

4px base unit:
| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | `4px` | Tight spacing, inline gaps |
| `--space-2` | `8px` | Component internal padding |
| `--space-3` | `12px` | Card padding, element gaps |
| `--space-4` | `16px` | Section padding |
| `--space-5` | `24px` | Large gaps |
| `--space-6` | `32px` | Section separators |

---

## Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--r-sm` | `6px` | Inputs, small elements |
| `--r-md` | `10px` | Cards, buttons |
| `--r-lg` | `14px` | Panels, larger cards |
| `--r-xl` | `20px` | Modals, hero elements |

---

## Shadows

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 3px` | Subtle elevation |
| `--shadow-md` | `0 4px 16px` | Cards, dropdowns |
| `--shadow-lg` | `0 8px 32px` | Modals, overlays |

---

## Typography

**Font Stack**: `-apple-system, BlinkMacSystemFont, "Inter", "SF Pro Text", system-ui, sans-serif`
**Monospace**: `"SF Mono", Menlo, Consolas, monospace`

| Size | Weight | Usage |
|------|--------|-------|
| 10px | 600 | Badges, labels |
| 11px | 400-500 | Meta info, table cells |
| 12px | 400-600 | Secondary text, panel titles |
| 13px | 400 | Body text, buttons |
| 14px | 400 | Main content, inputs |
| 17px | 700 | Brand text (Seraphine) |
| 24px | 700 | Empty state headings |

**Gradient Text** (for headings/brand):
```css
background: var(--accent-gradient);
-webkit-background-clip: text;
-webkit-text-fill-color: transparent;
```

---

## Component Patterns

### Buttons

| Variant | Usage | Style |
|---------|-------|-------|
| `.btn-primary` | Main CTA | Gradient bg, glow shadow, hover lift |
| `.btn-ghost` | Secondary | bg-2, border, hover bg-3 |
| `.btn-confirm` | Approve | Green tint, green border |
| `.btn-reject` | Deny/delete | Red tint, red border |
| `.sidebar-google-btn` | Sidebar actions | Icon + label, vertical layout |

**All buttons**: `transition: all 200ms cubic-bezier(0.16, 1, 0.3, 1)`
- Hover: `translateY(-1px)` + enhanced shadow
- Active: `scale(0.98)`
- Focus-visible: purple ring

### Cards

```css
.card {
  background: var(--glass-bg);
  backdrop-filter: blur(8px);
  border: 1px solid var(--glass-border);
  border-radius: var(--r-md);
  padding: var(--space-3);
  box-shadow: var(--shadow-sm);
}
```

### Chat Bubbles

| Type | Border Radius | Background |
|------|---------------|------------|
| User | `16px 16px 4px 16px` | `rgba(74,222,128,0.08)` with green border |
| Assistant | `16px 16px 16px 4px` | `rgba(167,139,250,0.04)` with purple border |
| Error | Standard | Red tint |

### Modals

```css
.modal-overlay { backdrop-filter: blur(8px); }
.modal-content {
  border-radius: 16px;
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-lg);
}
```

### Inputs

```css
/* Default */
background: var(--bg-1);
border: 1px solid var(--border);
border-radius: var(--r-md);

/* Focus */
border-color: var(--accent);
box-shadow: var(--accent-glow), 0 0 0 3px rgba(167,139,250,0.08);
```

---

## Animation System

**Easing**: `cubic-bezier(0.16, 1, 0.3, 1)` — smooth deceleration for UI elements

| Animation | Duration | Usage |
|-----------|----------|-------|
| `fadeIn` | 300ms | Bubble entrance (opacity + translateY) |
| `pulse` | 2s | Status dot, online indicator |
| `blink` | 1s | Text cursor |
| `mic-pulse` | 1.2s | Recording button glow |
| `pulse-badge` | 1.5s | WhatsApp notification badge |
| `thinking-dots` | 1.4s | Streaming indicator |

**Transition defaults**: 200ms for interactions, 250ms for layout shifts

---

## Responsive Breakpoints

| Breakpoint | Layout |
|------------|--------|
| > 880px | 2-column: sidebar (380px) + chat (1fr) |
| <= 880px | Single column, sidebar becomes horizontal strip |
| <= 768px | Mobile optimizations |
| <= 380px | Small phone adjustments |

**Mobile specifics**:
- Touch targets: minimum 44x44px
- Input font: 16px (prevents iOS zoom)
- Sidebar panels: slide-in drawer from right

---

## Finance Category Colors

| Category | Color | Emoji |
|----------|-------|-------|
| Moradia | `#5c6bc0` | 🏠 |
| Alimentacao | `#ff7043` | 🍔 |
| Transporte | `#26a69a` | 🚗 |
| Saude | `#ef5350` | 💊 |
| Lazer | `#ab47bc` | 🎮 |
| Educacao | `#42a5f5` | 📚 |
| Salario | `#66bb6a` | 💰 |
| Freelance | `#8bc34a` | 💻 |
| Investimento | `#ffa726` | 📈 |
| Outros | `#78909c` | 📦 |

---

## Scrollbar

Slim, minimal, transparent:
```css
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
```

---

## File Structure

```
frontend/src/
  styles.css          ← Single source of truth (all tokens + components)
  App.tsx             ← Layout shell, view switching, state management
  chat/ChatView.tsx   ← Chat interface, bubbles, composer
  finance/            ← Financial dashboard components
  google/             ← Calendar & email modals
  memory/             ← Memory panel
  tools/              ← Approval panel
  avatar/             ← VRM 3D avatar
  ws/                 ← WebSocket client + types
```

---

## Principles

1. **Depth through layers** — use glass, shadows, and elevation to create depth
2. **Purple is the hero** — accent gradient for CTAs, brand, and focus states
3. **Green = user, Purple = Seraphine** — consistent color coding
4. **Transitions everywhere** — no state change without animation
5. **Mobile-first responsive** — works on every screen size
6. **Accessibility** — focus-visible rings, sufficient contrast, aria labels
