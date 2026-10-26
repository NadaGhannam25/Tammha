/** Public user fields safe to show inside a workspace (never the password). */
export const PUBLIC_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  avatar: true,
  role: true,
  universityId: true,
} as const;
