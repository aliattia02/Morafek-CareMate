/**
 * Admin — Erasure Requests Screen
 * Location: mobile/app/(app)/admin/erasure-requests.tsx
 *
 * Approval queue for patient right-to-erasure requests
 * (GET/POST /api/admin/erasure-requests). Approve is instant, permanent,
 * irreversible deletion of research_vitals rows — no undo — so it's gated
 * behind a typed confirmation, not a simple tap.
 *
 * Will legitimately show an empty "pending" list until the patient-facing
 * creation endpoint (POST /api/patient/erasure-request) exists — this is
 * documented backend behavior, not a bug in this screen.
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Modal,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, Loading } from '@/components/ui';
import {
  getErasureRequests,
  actionErasureRequest,
  type ErasureRequest,
  type ErasureStatusFilter,
} from '@/services/api/admin';
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

const CONFIRM_PHRASE = 'DELETE';

const showAlert = (title: string, message: string) => {
  if (Platform.OS === 'web') window.alert(`${title}\n\n${message}`);
  else Alert.alert(title, message);
};

// ─── status filter strip ───────────────────────────────────────────────────

const STATUS_FILTERS: { id: ErasureStatusFilter; label: string }[] = [
  { id: 'pending', label: 'Pending' },
  { id: 'approved', label: 'Approved' },
  { id: 'denied', label: 'Denied' },
  { id: 'all', label: 'All' },
];

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ─── screen ───────────────────────────────────────────────────────────────────

export default function ErasureRequestsScreen() {
  const [statusFilter, setStatusFilter] = useState<ErasureStatusFilter>('pending');
  const [requests, setRequests] = useState<ErasureRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── approve modal state ──
  const [approveTarget, setApproveTarget] = useState<ErasureRequest | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [approving, setApproving] = useState(false);

  // ── deny modal state ──
  const [denyTarget, setDenyTarget] = useState<ErasureRequest | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [denying, setDenying] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await getErasureRequests(statusFilter);
      setRequests(data.requests);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to load erasure requests');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [statusFilter]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const onRefresh = useCallback(() => { setRefreshing(true); load(); }, [load]);

  // ── approve ──────────────────────────────────────────────────────────────
  const openApprove = (req: ErasureRequest) => {
    setApproveTarget(req);
    setConfirmText('');
  };

  const handleApprove = async () => {
    if (!approveTarget) return;
    setApproving(true);
    try {
      const result = await actionErasureRequest(approveTarget.request_id, 'approve');
      setApproveTarget(null);
      showAlert('Request approved', `Permanently deleted ${(result as any).deleted_count} research_vitals row(s).`);
      await load();
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setApproveTarget(null);
        showAlert('Already actioned', 'This request was already approved or denied — refreshing the list.');
        await load();
      } else {
        showAlert('Approve failed', err?.response?.data?.error || err?.message || 'Please try again.');
      }
    } finally {
      setApproving(false);
    }
  };

  // ── deny ─────────────────────────────────────────────────────────────────
  const openDeny = (req: ErasureRequest) => {
    setDenyTarget(req);
    setDenyReason('');
  };

  const handleDeny = async () => {
    if (!denyTarget) return;
    setDenying(true);
    try {
      await actionErasureRequest(denyTarget.request_id, 'deny', denyReason.trim() || undefined);
      setDenyTarget(null);
      await load();
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setDenyTarget(null);
        showAlert('Already actioned', 'This request was already approved or denied — refreshing the list.');
        await load();
      } else {
        showAlert('Deny failed', err?.response?.data?.error || err?.message || 'Please try again.');
      }
    } finally {
      setDenying(false);
    }
  };

  // ── render item ──────────────────────────────────────────────────────────
  const renderItem = ({ item }: { item: ErasureRequest }) => (
    <Card variant="outlined" padding="medium" style={styles.reqCard}>
      <View style={styles.reqHeader}>
        <View style={[
          styles.statusBadge,
          item.status === 'pending' ? styles.statusPending :
          item.status === 'approved' ? styles.statusApproved : styles.statusDenied,
        ]}>
          <Text style={styles.statusBadgeText}>{item.status.toUpperCase()}</Text>
        </View>
        <View style={styles.affectedBadge}>
          <Text style={styles.affectedBadgeText}>{item.affected_row_count} rows</Text>
        </View>
      </View>

      <Text style={styles.patientId} numberOfLines={1}>Patient: {item.patient_id}</Text>
      <Text style={styles.pseudonym} numberOfLines={1}>Pseudonym: {item.research_pseudonym}</Text>

      <View style={styles.dateRow}>
        <Text style={styles.dateLabel}>Requested</Text>
        <Text style={styles.dateValue}>{formatDate(item.requested_at)}</Text>
      </View>
      {item.reviewed_at && (
        <View style={styles.dateRow}>
          <Text style={styles.dateLabel}>Reviewed</Text>
          <Text style={styles.dateValue}>{formatDate(item.reviewed_at)} by {item.reviewed_by}</Text>
        </View>
      )}
      {item.reason && (
        <Text style={styles.reasonText}>Reason: {item.reason}</Text>
      )}

      {item.status === 'pending' && (
        <View style={styles.actionsRow}>
          <TouchableOpacity style={styles.denyButton} onPress={() => openDeny(item)}>
            <Text style={styles.denyButtonText}>Deny</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.approveButton} onPress={() => openApprove(item)}>
            <Text style={styles.approveButtonText}>🗑️ Approve &amp; Delete</Text>
          </TouchableOpacity>
        </View>
      )}
    </Card>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <Stack.Screen options={{ title: 'Erasure Requests' }} />

      <FlatList
        horizontal
        data={STATUS_FILTERS}
        keyExtractor={(f) => f.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterList}
        renderItem={({ item }) => {
          const active = item.id === statusFilter;
          return (
            <TouchableOpacity
              style={[styles.pill, active && styles.pillActive]}
              onPress={() => setStatusFilter(item.id)}
              activeOpacity={0.75}
            >
              <Text style={[styles.pillText, active && styles.pillTextActive]}>{item.label}</Text>
            </TouchableOpacity>
          );
        }}
      />

      {loading ? (
        <Loading text="Loading erasure requests…" />
      ) : (
        <FlatList
          data={requests}
          keyExtractor={(item) => item.request_id}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} />}
          renderItem={renderItem}
          ListEmptyComponent={
            error ? (
              <Card variant="outlined" padding="medium" style={styles.errorCard}>
                <Text style={styles.errorText}>⚠️ {error}</Text>
              </Card>
            ) : (
              <View style={styles.emptyState}>
                <Text style={styles.emptyIcon}>📭</Text>
                <Text style={styles.emptyTitle}>No {statusFilter !== 'all' ? statusFilter : ''} requests</Text>
                <Text style={styles.emptySub}>
                  {statusFilter === 'pending'
                    ? 'The patient-facing request screen isn’t built yet, so this queue is empty by default.'
                    : 'Nothing matches this filter.'}
                </Text>
              </View>
            )
          }
        />
      )}

      {/* ── Approve modal — typed confirmation ── */}
      <Modal
        visible={!!approveTarget}
        transparent
        animationType="fade"
        onRequestClose={() => !approving && setApproveTarget(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalIcon}>🗑️</Text>
            <Text style={styles.modalTitle}>Approve &amp; Delete</Text>
            <Text style={styles.modalSubtitle}>This permanently deletes research data. This cannot be undone.</Text>

            <View style={styles.modalWarningBox}>
              <Text style={styles.modalWarningText}>
                This will permanently delete{' '}
                <Text style={styles.modalWarningCount}>{approveTarget?.affected_row_count ?? 0}</Text>
                {' '}research_vitals row(s) for pseudonym{'\n'}
                <Text style={styles.modalWarningPseudonym}>{approveTarget?.research_pseudonym}</Text>
              </Text>
            </View>

            <Text style={styles.confirmLabel}>TYPE "{CONFIRM_PHRASE}" TO CONFIRM</Text>
            <TextInput
              style={styles.confirmInput}
              value={confirmText}
              onChangeText={setConfirmText}
              placeholder={CONFIRM_PHRASE}
              placeholderTextColor={colors.text.disabled}
              autoCapitalize="characters"
              editable={!approving}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.cancelBtn}
                onPress={() => setApproveTarget(null)}
                disabled={approving}
              >
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.confirmDeleteBtn,
                  (confirmText !== CONFIRM_PHRASE || approving) && styles.confirmDeleteBtnDisabled,
                ]}
                onPress={handleApprove}
                disabled={confirmText !== CONFIRM_PHRASE || approving}
              >
                <Text style={styles.confirmDeleteBtnText}>
                  {approving ? 'Deleting…' : 'Delete Permanently'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Deny modal ── */}
      <Modal
        visible={!!denyTarget}
        transparent
        animationType="fade"
        onRequestClose={() => !denying && setDenyTarget(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalIcon}>✕</Text>
            <Text style={styles.modalTitle}>Deny Request</Text>
            <Text style={styles.modalSubtitle}>No data will be touched. The request will be marked denied.</Text>

            <Text style={styles.confirmLabel}>REASON (OPTIONAL)</Text>
            <TextInput
              style={[styles.confirmInput, styles.reasonInput]}
              value={denyReason}
              onChangeText={setDenyReason}
              placeholder="Why is this request being denied?"
              placeholderTextColor={colors.text.disabled}
              multiline
              editable={!denying}
            />

            <View style={styles.modalActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setDenyTarget(null)} disabled={denying}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.denyConfirmBtn} onPress={handleDeny} disabled={denying}>
                <Text style={styles.confirmDeleteBtnText}>{denying ? 'Denying…' : 'Deny Request'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },

  filterList: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingTop: spacing.md, paddingBottom: spacing.sm },
  pill: {
    paddingVertical: spacing.xs, paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  pillText: { ...typography.small, color: colors.text.secondary, fontWeight: '500' },
  pillTextActive: { color: colors.text.inverse, fontWeight: '600' },

  listContent: { padding: spacing.md, paddingTop: 0, gap: spacing.sm },

  reqCard: { gap: 6 },
  reqHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  statusBadge: { borderRadius: borderRadius.full, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  statusPending: { backgroundColor: colors.warningLight + '35' },
  statusApproved: { backgroundColor: colors.danger + '22' },
  statusDenied: { backgroundColor: colors.divider },
  statusBadgeText: { ...typography.small, fontWeight: '700', color: colors.text.primary },

  affectedBadge: { backgroundColor: colors.dangerLight + '25', borderRadius: borderRadius.full, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  affectedBadgeText: { ...typography.small, fontWeight: '700', color: colors.dangerDark },

  patientId: { ...typography.caption, fontWeight: '600', color: colors.text.primary, fontFamily: 'Courier New' },
  pseudonym: { ...typography.small, color: colors.text.secondary, fontFamily: 'Courier New' },

  dateRow: { flexDirection: 'row', justifyContent: 'space-between' },
  dateLabel: { ...typography.small, color: colors.text.secondary },
  dateValue: { ...typography.small, color: colors.text.primary },
  reasonText: { ...typography.small, color: colors.text.secondary, fontStyle: 'italic', marginTop: 2 },

  actionsRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  denyButton: {
    flex: 1, height: 40, borderRadius: borderRadius.sm, borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  denyButtonText: { ...typography.caption, fontWeight: '700', color: colors.text.secondary },
  approveButton: {
    flex: 2, height: 40, borderRadius: borderRadius.sm, backgroundColor: colors.danger,
    alignItems: 'center', justifyContent: 'center',
  },
  approveButtonText: { ...typography.caption, fontWeight: '700', color: '#fff' },

  errorCard: { borderColor: colors.danger, margin: spacing.md },
  errorText: { ...typography.small, color: colors.danger },

  emptyState: { alignItems: 'center', paddingVertical: spacing.xl, gap: 4, paddingHorizontal: spacing.lg },
  emptyIcon: { fontSize: 36 },
  emptyTitle: { ...typography.body, fontWeight: '700', color: colors.text.secondary, textTransform: 'capitalize' },
  emptySub: { ...typography.caption, color: colors.text.secondary, textAlign: 'center' },

  // ── modals ──
  modalOverlay: { flex: 1, backgroundColor: 'rgba(10,20,22,0.6)', justifyContent: 'center', alignItems: 'center', padding: spacing.md },
  modalCard: { backgroundColor: colors.surface, borderRadius: borderRadius.lg, padding: spacing.md, width: '100%', maxWidth: 420 },
  modalIcon: { fontSize: 32, textAlign: 'center', marginBottom: spacing.xs },
  modalTitle: { ...typography.h3, color: colors.text.primary, textAlign: 'center', marginBottom: 2 },
  modalSubtitle: { ...typography.caption, color: colors.text.secondary, textAlign: 'center', marginBottom: spacing.md },

  modalWarningBox: {
    backgroundColor: colors.dangerLight + '20', borderRadius: borderRadius.sm, borderLeftWidth: 4, borderLeftColor: colors.danger,
    padding: spacing.sm, marginBottom: spacing.md,
  },
  modalWarningText: { ...typography.caption, color: colors.dangerDark, lineHeight: 20, textAlign: 'center' },
  modalWarningCount: { fontWeight: '800', fontSize: 16 },
  modalWarningPseudonym: { fontFamily: 'Courier New', fontWeight: '700' },

  confirmLabel: { ...typography.small, fontWeight: '700', color: colors.text.secondary, marginBottom: 6, letterSpacing: 0.5 },
  confirmInput: {
    height: 48, borderRadius: borderRadius.sm, borderWidth: 1.5, borderColor: colors.border,
    backgroundColor: colors.background, paddingHorizontal: spacing.sm, ...typography.body, color: colors.text.primary,
  },
  reasonInput: { height: 80, textAlignVertical: 'top', paddingTop: spacing.sm },

  modalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  cancelBtn: {
    flex: 1, height: 48, borderRadius: borderRadius.sm, borderWidth: 1.5, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface,
  },
  cancelBtnText: { ...typography.body, fontWeight: '700', color: colors.text.secondary },
  confirmDeleteBtn: { flex: 2, height: 48, borderRadius: borderRadius.sm, backgroundColor: colors.danger, alignItems: 'center', justifyContent: 'center' },
  confirmDeleteBtnDisabled: { opacity: 0.4 },
  confirmDeleteBtnText: { ...typography.body, fontWeight: '700', color: '#fff' },
  denyConfirmBtn: { flex: 2, height: 48, borderRadius: borderRadius.sm, backgroundColor: colors.text.secondary, alignItems: 'center', justifyContent: 'center' },
});
