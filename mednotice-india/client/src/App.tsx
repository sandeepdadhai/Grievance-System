import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth, REVIEWER_ROLES, STAFF_ROLES } from "./auth";
import { hasPermission } from "./api";
import { AdminLayout, PublicLayout } from "./components/Layout";
import { LoadingPage } from "./components/ui";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Community from "./pages/Community";
import CommunityPostDetail from "./pages/CommunityPost";
import Submit from "./pages/Submit";
import Track from "./pages/Track";
import Portal from "./pages/Portal";
import CaseDetail from "./pages/CaseDetail";
import AdminOverview from "./pages/admin/Overview";
import AdminCases from "./pages/admin/Cases";
import AdminUsers from "./pages/admin/Users";
import AdminAudit from "./pages/admin/Audit";
import AdminAdapters from "./pages/admin/Adapters";
import AdminCompliance from "./pages/admin/Compliance";
import AdminDelivery from "./pages/admin/Delivery";
import AdminCommunity from "./pages/admin/Community";

function Protected({ roles, permission, children }: { roles?: string[]; permission?: string; children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingPage />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  const home = user.baseRole === "PATIENT" ? "/portal" : "/admin";
  if (roles && !roles.includes(user.baseRole)) return <Navigate to={home} replace />;
  if (permission && !hasPermission(user, permission)) return <Navigate to={home} replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<Home />} />
        <Route path="submit" element={<Submit />} />
        <Route path="track" element={<Track />} />
        <Route path="community" element={<Community />} />
        <Route path="community/:id" element={<CommunityPostDetail />} />
        <Route path="login" element={<Login />} />
        <Route path="signup" element={<Signup />} />
        <Route
          path="portal"
          element={
            <Protected roles={["PATIENT"]}>
              <Portal />
            </Protected>
          }
        />
        <Route
          path="cases/:id"
          element={
            <Protected>
              <CaseDetail />
            </Protected>
          }
        />
      </Route>

      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        <Route path="cases" element={<AdminCases />} />
        <Route path="cases/:id" element={<CaseDetail staff />} />
        <Route
          path="users"
          element={
            <Protected roles={["SUPER_ADMIN"]}>
              <AdminUsers />
            </Protected>
          }
        />
        <Route
          path="audit"
          element={
            <Protected permission="audit.view">
              <AdminAudit />
            </Protected>
          }
        />
        <Route
          path="delivery"
          element={
            <Protected roles={[...REVIEWER_ROLES, "SYSTEM_AUDITOR"]}>
              <AdminDelivery />
            </Protected>
          }
        />
        <Route
          path="community"
          element={
            <Protected permission="community.moderate">
              <AdminCommunity />
            </Protected>
          }
        />
        <Route path="adapters" element={<AdminAdapters />} />
        <Route path="compliance" element={<AdminCompliance />} />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export { STAFF_ROLES };
