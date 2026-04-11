/**
 * EHR Documents Screen
 * Location: mobile/app/(app)/ehr/documents.tsx
 *
 * Works for both patients and doctors:
 * - Patient: fetches own documents, can upload and delete
 * - Doctor: receives patient_id via route params, views patient documents
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  TextInput,
  Linking,
  RefreshControl,
  Platform,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useAuthStore } from '@/store/auth.store';
import { colors } from '@/constants/theme';
import { E, ET } from '@/constants/elderlyTheme';
import {
  getMyDocuments,
  getDoctorPatientDocuments,
  uploadDocument,
  deleteDocument,
  type DocumentResponse,
  type DocumentCategory,
} from '@/services/api/ehr';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_META: Record<DocumentCategory, { icon: string; label: string; color: string; bg: string }> = {
  lab_report:   { icon: '🧪', label: 'Lab Report',   color: '#1565C0', bg: '#E3F2FD' },
  imaging:      { icon: '🩻', label: 'Imaging',       color: '#6A1B9A', bg: '#F3E5F5' },
  prescription: { icon: '💊', label: 'Prescription',  color: '#1A8C5B', bg: '#E6F5EE' },
  other:        { icon: '📄', label: 'Other',          color: '#546E7A', bg: '#ECEFF1' },
};

const CATEGORY_ICONS: Record<DocumentCategory, string> = Object.fromEntries(
  Object.entries(CATEGORY_META).map(([k, v]) => [k, v.icon])
) as Record<DocumentCategory, string>;

const CATEGORY_LABELS: Record<DocumentCategory, string> = Object.fromEntries(
  Object.entries(CATEGORY_META).map(([k, v]) => [k, v.label])
) as Record<DocumentCategory, string>;

const ALL_CATEGORIES: DocumentCategory[] = ['lab_report', 'imaging', 'prescription', 'other'];

function groupByCategory(docs: DocumentResponse[]): Record<DocumentCategory, DocumentResponse[]> {
  const groups: Record<DocumentCategory, DocumentResponse[]> = {
    lab_report: [],
    imaging: [],
    prescription: [],
    other: [],
  };
  for (const doc of docs) {
    const cat = doc.category in groups ? doc.category : 'other';
    groups[cat].push(doc);
  }
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen
// ─────────────────────────────────────────────────────────────────────────────

export default function DocumentsScreen() {
  const { patient_id } = useLocalSearchParams<{ patient_id?: string }>();
  const { user } = useAuthStore();
  const isDoctor = user?.user_type === 'doctor' || user?.user_type === 'admin';
  const isPatient = !isDoctor;

  const [documents, setDocuments] = useState<DocumentResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Upload state
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCategory, setUploadCategory] = useState<DocumentCategory>('other');
  const [uploadDescription, setUploadDescription] = useState('');
  const [pickedFile, setPickedFile] = useState<{ uri: string; name: string; type: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  const loadDocuments = useCallback(async () => {
    try {
      setError(null);
      let data: DocumentResponse[];
      if (isDoctor && patient_id) {
        data = await getDoctorPatientDocuments(patient_id);
      } else {
        data = await getMyDocuments();
      }
      setDocuments(data);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load documents';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [isDoctor, patient_id]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadDocuments();
    setRefreshing(false);
  }, [loadDocuments]);

  const handleView = (url: string) => {
    Linking.openURL(url).catch(() => {
      Alert.alert('Error', 'Unable to open document.');
    });
  };

  const handleDelete = (doc: DocumentResponse) => {
    Alert.alert(
      'Delete Document',
      `Are you sure you want to delete "${doc.description || 'this document'}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteDocument(doc.id);
              setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : 'Failed to delete document';
              Alert.alert('Error', message);
            }
          },
        },
      ]
    );
  };

  const handlePickImage = async () => {
    // FIX 1: MediaTypeOptions (not MediaType) — works on all Expo SDK versions
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.85,
    });

    if (!result.canceled && result.assets.length > 0) {
      const asset = result.assets[0];
      const name = asset.fileName ?? `photo_${Date.now()}.jpg`;
      const type = asset.mimeType ?? 'image/jpeg';

      // FIX 2: On web, expo-image-picker returns a base64 data URI.
      // We convert it to an object URL here so that uploadDocument (ehr.ts)
      // can later fetch() it into a real Blob for FormData.
      let uri = asset.uri;
      if (Platform.OS === 'web' && uri.startsWith('data:')) {
        const fetchResponse = await fetch(uri);
        const blob = await fetchResponse.blob();
        uri = URL.createObjectURL(blob);
      }

      setPickedFile({ uri, name, type });
    }
  };

  const handlePickPDF = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: 'application/pdf',
      copyToCacheDirectory: true,
    });
    if (!result.canceled && result.assets.length > 0) {
      const asset = result.assets[0];
      setPickedFile({ uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'application/pdf' });
    }
  };

  const handleUpload = async () => {
    if (!pickedFile) {
      Alert.alert('No file selected', 'Please pick an image or PDF first.');
      return;
    }
    if (!uploadDescription.trim()) {
      Alert.alert('Description required', 'Please enter a description for this document.');
      return;
    }
    try {
      setUploading(true);
      const newDoc = await uploadDocument(pickedFile, uploadCategory, uploadDescription.trim());
      setDocuments((prev) => [newDoc, ...prev]);
      setShowUpload(false);
      setPickedFile(null);
      setUploadDescription('');
      setUploadCategory('other');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      Alert.alert('Upload Error', message);
    } finally {
      setUploading(false);
    }
  };

  // Clean up any object URLs we created on web to avoid memory leaks
  const resetUploadPanel = () => {
    if (Platform.OS === 'web' && pickedFile?.uri.startsWith('blob:')) {
      URL.revokeObjectURL(pickedFile.uri);
    }
    setShowUpload(false);
    setPickedFile(null);
    setUploadDescription('');
    setUploadCategory('other');
  };

  const grouped = groupByCategory(documents);

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[E.colors.primary]}
          />
        }
      >
        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        )}

        {loading ? (
          <ActivityIndicator color={E.colors.primary} style={styles.loader} />
        ) : documents.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyStateIcon}>📂</Text>
            <Text style={styles.emptyStateTitle}>No documents yet</Text>
            <Text style={styles.emptyStateSub}>Upload lab reports, imaging, prescriptions and more.</Text>
          </View>
        ) : (
          ALL_CATEGORIES.map((cat) => {
            const items = grouped[cat];
            const meta = CATEGORY_META[cat];
            if (items.length === 0) return null;
            return (
              <View key={cat} style={styles.section}>
                <View style={[styles.sectionBanner, { backgroundColor: meta.bg }]}>
                  <Text style={styles.sectionBannerIcon}>{meta.icon}</Text>
                  <Text style={[styles.sectionBannerText, { color: meta.color }]}>{meta.label}</Text>
                  <Text style={[styles.sectionBannerCount, { color: meta.color }]}>{items.length}</Text>
                </View>
                {items.map((doc) => (
                  <View key={doc.id} style={styles.docCard}>
                    <View style={styles.docInfo}>
                      <Text style={styles.docDescription} numberOfLines={2}>
                        {doc.description || '(No description)'}
                      </Text>
                      <Text style={styles.docDate}>{doc.created_at}</Text>
                    </View>
                    <View style={styles.docActions}>
                      <TouchableOpacity
                        style={styles.viewButton}
                        onPress={() => handleView(doc.url)}
                      >
                        <Text style={styles.viewButtonText}>View</Text>
                      </TouchableOpacity>
                      {isPatient && (
                        <TouchableOpacity
                          style={styles.deleteButton}
                          onPress={() => handleDelete(doc)}
                        >
                          <Text style={styles.deleteButtonText}>Delete</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            );
          })
        )}

        {/* Spacer so content isn't hidden behind upload panel */}
        {isPatient && <View style={{ height: 80 }} />}
      </ScrollView>

      {/* Upload Panel — patients only */}
      {isPatient && (
        <View style={styles.uploadPanel}>
          {showUpload ? (
            <View style={styles.uploadForm}>
              {/* Category picker */}
              <Text style={styles.uploadLabel}>Category</Text>
              <View style={styles.categoryRow}>
                {ALL_CATEGORIES.map((cat) => (
                  <TouchableOpacity
                    key={cat}
                    style={[
                      styles.categoryButton,
                      uploadCategory === cat && styles.categoryButtonActive,
                    ]}
                    onPress={() => setUploadCategory(cat)}
                  >
                    <Text style={styles.categoryButtonIcon}>{CATEGORY_ICONS[cat]}</Text>
                    <Text
                      style={[
                        styles.categoryButtonText,
                        uploadCategory === cat && styles.categoryButtonTextActive,
                      ]}
                    >
                      {CATEGORY_LABELS[cat]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Description */}
              <Text style={styles.uploadLabel}>Description</Text>
              <TextInput
                style={styles.descriptionInput}
                placeholder="Enter a description…"
                placeholderTextColor={E.colors.textSecondary}
                value={uploadDescription}
                onChangeText={setUploadDescription}
              />

              {/* File pickers */}
              <View style={styles.pickerRow}>
                <TouchableOpacity style={styles.pickerButton} onPress={handlePickImage}>
                  <Text style={styles.pickerButtonText}>📷 Pick Image</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.pickerButton} onPress={handlePickPDF}>
                  <Text style={styles.pickerButtonText}>📎 Pick PDF</Text>
                </TouchableOpacity>
              </View>
              {pickedFile && (
                <Text style={styles.pickedFileName} numberOfLines={1}>
                  ✅ {pickedFile.name}
                </Text>
              )}

              {/* Actions */}
              <View style={styles.uploadActions}>
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={resetUploadPanel}
                  disabled={uploading}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.confirmButton, uploading && styles.confirmButtonDisabled]}
                  onPress={handleUpload}
                  disabled={uploading}
                >
                  {uploading ? (
                    <ActivityIndicator color={E.colors.textInverse} size="small" />
                  ) : (
                    <Text style={styles.confirmButtonText}>Upload</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.uploadButton}
              onPress={() => setShowUpload(true)}
            >
              <Text style={styles.uploadButtonText}>+ Upload Document</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </SafeAreaView>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: E.colors.bg,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: E.padSm,
    paddingBottom: 40,
  },
  loader: {
    marginTop: 40,
  },
  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingVertical: 48,
    paddingHorizontal: E.pad,
    gap: E.padSm,
  },
  emptyStateIcon: { fontSize: 52 },
  emptyStateTitle: {
    ...ET.h3,
  },
  emptyStateSub: {
    ...ET.body,
    color: E.colors.textSecondary,
    textAlign: 'center',
  },
  errorContainer: {
    padding: E.padSm,
    backgroundColor: E.colors.dangerLight,
    borderRadius: E.radiusSm,
    borderLeftWidth: 4,
    borderLeftColor: E.colors.danger,
    marginBottom: E.padSm,
  },
  errorText: {
    ...ET.body,
    color: E.colors.danger,
  },
  section: {
    marginBottom: E.padSm,
  },
  // Section header — colored banner
  sectionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: E.radiusSm,
    paddingHorizontal: E.padSm,
    paddingVertical: E.padXs + 2,
    marginBottom: E.padXs,
  },
  sectionBannerIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  sectionBannerText: {
    ...ET.bodyBold,
    flex: 1,
  },
  sectionBannerCount: {
    ...ET.caption,
    fontWeight: '700',
  },
  docCard: {
    backgroundColor: E.colors.surface,
    borderRadius: E.radiusSm,
    borderWidth: 1,
    borderColor: E.colors.border,
    padding: E.padSm,
    marginBottom: E.padXs,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...E.shadowSm,
  },
  docInfo: {
    flex: 1,
    marginRight: E.padXs,
  },
  docDescription: {
    ...ET.bodyBold,
  },
  docDate: {
    ...ET.small,
    marginTop: 2,
  },
  docActions: {
    flexDirection: 'row',
    gap: E.padXs,
  },
  viewButton: {
    backgroundColor: E.colors.primary,
    borderRadius: E.radiusSm,
    paddingHorizontal: E.padSm,
    paddingVertical: E.padXs,
  },
  viewButtonText: {
    ...ET.small,
    color: E.colors.textInverse,
    fontWeight: '600',
  },
  deleteButton: {
    backgroundColor: E.colors.dangerLight,
    borderRadius: E.radiusSm,
    borderWidth: 1,
    borderColor: E.colors.danger,
    paddingHorizontal: E.padSm,
    paddingVertical: E.padXs,
  },
  deleteButtonText: {
    ...ET.small,
    color: E.colors.danger,
    fontWeight: '600',
  },
  // Upload panel
  uploadPanel: {
    borderTopWidth: 1,
    borderTopColor: E.colors.border,
    backgroundColor: E.colors.surface,
    padding: E.padSm,
    paddingBottom: Platform.OS === 'ios' ? E.pad : E.padSm,
  },
  uploadButton: {
    backgroundColor: E.colors.primary,
    borderRadius: E.radius,
    height: E.tap,
    alignItems: 'center',
    justifyContent: 'center',
    ...E.shadow,
  },
  uploadButtonText: {
    ...ET.btnPrimary,
  },
  uploadForm: {
    gap: E.padXs,
  },
  uploadLabel: {
    ...ET.label,
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: E.padXs,
  },
  // Pill-shaped category chips
  categoryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: E.padXs,
    borderWidth: 1,
    borderColor: E.colors.border,
    borderRadius: E.radiusFull,
    paddingHorizontal: E.padSm,
    paddingVertical: E.padXs,
    backgroundColor: E.colors.bg,
  },
  categoryButtonActive: {
    borderColor: E.colors.primary,
    backgroundColor: E.colors.primaryLight,
  },
  categoryButtonIcon: {
    fontSize: 14,
  },
  categoryButtonText: {
    ...ET.small,
  },
  categoryButtonTextActive: {
    color: E.colors.primary,
    fontWeight: '600',
  },
  descriptionInput: {
    ...ET.body,
    color: E.colors.textPrimary,
    backgroundColor: E.colors.bg,
    borderRadius: E.radiusSm,
    borderWidth: 1,
    borderColor: E.colors.border,
    paddingHorizontal: E.padSm,
    paddingVertical: E.padXs,
  },
  pickerRow: {
    flexDirection: 'row',
    gap: E.padXs,
  },
  pickerButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: E.colors.primary,
    borderRadius: E.radiusSm,
    height: E.tap,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerButtonText: {
    ...ET.bodyBold,
    color: E.colors.primary,
  },
  pickedFileName: {
    ...ET.small,
    color: E.colors.success,
  },
  uploadActions: {
    flexDirection: 'row',
    gap: E.padXs,
    marginTop: E.padXs,
  },
  cancelButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: E.colors.border,
    borderRadius: E.radiusSm,
    height: E.tap,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelButtonText: {
    ...ET.bodyBold,
    color: E.colors.textSecondary,
  },
  confirmButton: {
    flex: 2,
    backgroundColor: E.colors.primary,
    borderRadius: E.radiusSm,
    height: E.tap,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmButtonDisabled: {
    opacity: 0.6,
  },
  confirmButtonText: {
    ...ET.btnPrimary,
  },
});