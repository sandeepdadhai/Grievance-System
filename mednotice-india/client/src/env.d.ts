/**
 * Build-time variables for the patient application. The staff console is a
 * separate deployment, so the patient bundle only needs its origin to link to
 * it. Set VITE_ADMIN_URL when building (`VITE_ADMIN_URL=https://admin.example.org npm run build`).
 */
interface ImportMetaEnv {
  /** Absolute origin of the separately deployed staff console. */
  readonly VITE_ADMIN_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
