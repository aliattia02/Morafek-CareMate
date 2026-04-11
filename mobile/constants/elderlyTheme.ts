/**
 * Elderly / Accessibility-First Design Tokens
 * Warm clinical palette — calming teal primary, generous sizing, strong contrast
 */

export const E = {
  colors: {
    // Brand
    primary:      '#0E7C8B',   // Deep teal
    primaryLight: '#E6F4F6',   // Tint for backgrounds
    primaryDark:  '#0A5E6A',   // Pressed state
    accent:       '#F5A623',   // Warm amber — used for highlights
    accentLight:  '#FEF3DC',

    // Semantics
    success:      '#1A8C5B',
    successLight: '#E6F5EE',
    warning:      '#D97706',
    warningLight: '#FEF3DC',
    danger:       '#C0392B',
    dangerLight:  '#FDECEA',

    // Neutrals
    bg:           '#F7F9FA',   // Warm off-white background
    surface:      '#FFFFFF',   // Card surface
    surfaceAlt:   '#F0F4F5',   // Secondary surface
    border:       '#DDE3E5',   // Subtle border
    divider:      '#EEF1F2',

    // Text
    textPrimary:   '#1A2B30',  // Near black
    textSecondary: '#6B8087',  // Mid gray
    textInverse:   '#FFFFFF',
    textMuted:     '#9AACB1',
  },

  // Spacing
  pad:  20,
  padSm: 12,
  padXs: 8,

  // Radii
  radius:   16,
  radiusSm: 10,
  radiusXs:  6,
  radiusFull: 999,

  // Touch targets — WCAG AA minimum 44×44, we go bigger
  tap:   64,
  tapXL: 72,

  // Shadows — cross-platform
  shadow: {
    shadowColor: '#1A2B30',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 8,
    elevation: 3,
  },
  shadowSm: {
    shadowColor: '#1A2B30',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 2,
  },
};

export const ET = {
  // Display — BP numbers
  display: {
    fontSize: 48,
    fontWeight: '700' as const,
    color: E.colors.textPrimary,
    letterSpacing: -1,
  },
  // Headings
  h1: {
    fontSize: 28,
    fontWeight: '700' as const,
    color: E.colors.textPrimary,
    letterSpacing: -0.5,
  },
  h2: {
    fontSize: 22,
    fontWeight: '700' as const,
    color: E.colors.textPrimary,
  },
  h3: {
    fontSize: 18,
    fontWeight: '600' as const,
    color: E.colors.textPrimary,
  },
  // Body
  body: {
    fontSize: 17,
    fontWeight: '400' as const,
    color: E.colors.textPrimary,
    lineHeight: 24,
  },
  bodyBold: {
    fontSize: 17,
    fontWeight: '600' as const,
    color: E.colors.textPrimary,
  },
  // Utility
  label: {
    fontSize: 14,
    fontWeight: '600' as const,
    color: E.colors.textSecondary,
    letterSpacing: 0.3,
    textTransform: 'uppercase' as const,
  },
  small: {
    fontSize: 14,
    fontWeight: '400' as const,
    color: E.colors.textSecondary,
  },
  unit: {
    fontSize: 15,
    fontWeight: '400' as const,
    color: E.colors.textSecondary,
    marginTop: 4,
  },
  caption: {
    fontSize: 13,
    fontWeight: '400' as const,
    color: E.colors.textMuted,
  },
  // Button
  btnPrimary: {
    fontSize: 18,
    fontWeight: '700' as const,
    color: E.colors.textInverse,
    letterSpacing: 0.2,
  },
};
