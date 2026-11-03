import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { hasPermission } from "./api";
import { REVIEWER_ROLES, STAFF_ROLES, useAuth } from "./auth";
import { AdminLayout } from "./components/Layout";
import { LoadingPage } from "./components/ui";
import AdminLogin from "./pages/admin/Login";
import CaseDetail from "./pages/CaseDetail";
import AdminOverview from "./pages/admin/Overview";
import AdminCases from "./pages/admin/Cases";
import AdminFacility from "./pages/admin/Facility";
import AdminUsers from "./pages/admin/Users";
import AdminTheme from "./pages/admin/Theme";
import AdminAudit from "./pages/admin/Audit";
import AdminAdapters from "./pages/admin/Adapters";
import AdminCompliance from "./pages/admin/Compliance";
import AdminDelivery from "./pages/admin/Delivery";
import AdminDispatch from "./pages/admin/Dispatch";
import AdminCommunications from "./pages/admin/Communications";
import AdminCommunity from "./pages/admin/Community";
import AdminDirectory from "./pages/admin/Directory";

/**
 * Staff console. This bundle is served from its own origin by server/admin.ts,
 * so `/admin/...` paths are rooted at that origin and the console can be
 * restricted (bind address, IP allowlist, HTTP Basic) independently of the
 * public patient application.
 */
function StaffOnly({ roles, permission, children }: { roles?: string[]; permission?: string; children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingPage />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (user.baseRole === "PATIENT") return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.baseRole)) return <Navigate to="/admin" replace />;
  if (permission && !hasPermission(user, permission)) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

export default function AdminApp() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/login" element={<AdminLogin />} />

      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        <Route path="cases" element={<AdminCases />} />
        <Route path="cases/:id" element={<CaseDetail staff />} />
        <Route path="facility" element={<AdminFacility />} />
        <Route
          path="users"
          element={
            <StaffOnly roles={["SUPER_ADMIN"]}>
              <AdminUsers />
            </StaffOnly>
          }
        />
        <Route
          path="theme"
          element={
            <StaffOnly roles={["SUPER_ADMIN"]}>
              <AdminTheme />
            </StaffOnly>
          }
        />
        <Route
          path="audit"
          element={
            <StaffOnly permission="audit.view">
              <AdminAudit />
            </StaffOnly>
          }
        />
        <Route
          path="delivery"
          element={
            <StaffOnly roles={[...REVIEWER_ROLES, "SYSTEM_AUDITOR"]}>
              <AdminDelivery />
            </StaffOnly>
          }
        />
        <Route
          path="dispatch"
          element={
            <StaffOnly roles={[...STAFF_ROLES]}>
              <AdminDispatch />
            </StaffOnly>
          }
        />
        <Route
          path="communications"
          element={
            <StaffOnly roles={[...STAFF_ROLES]}>
              <AdminCommunications />
            </StaffOnly>
          }
        />
        <Route
          path="community"
          element={
            <StaffOnly permission="community.moderate">
              <AdminCommunity />
            </StaffOnly>
          }
        />
        <Route path="adapters" element={<AdminAdapters />} />
        <Route
          path="directory"
          element={
            <StaffOnly roles={[...STAFF_ROLES]}>
              <AdminDirectory />
            </StaffOnly>
          }
        />
        <Route path="compliance" element={<AdminCompliance />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}

export { STAFF_ROLES };
