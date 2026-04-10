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
import { colors, spacing, typography, borderRadius } from '@/constants/theme';
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

const CATEGORY_ICONS: Record<DocumentCategory, string> = {
  lab_report: '🧪',
  imaging: '🩻',
  prescription: '💊',
  other: '📄',
};

const CATEGORY_LABELS: Record<DocumentCategory, string> = {
  lab_report: 'Lab Report',
  imaging: 'Imaging',
  prescription: 'Prescription',
  other: 'Other',
};

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
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.85,
    });
    if (!result.canceled && result.assets.length > 0) {
      const asset = result.assets[0];
      const name = asset.fileName ?? `photo_${Date.now()}.jpg`;
      const type = asset.mimeType ?? 'image/jpeg';
      setPickedFile({ uri: asset.uri, name, type });
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
            colors={[colors.primary]}
          />
        }
      >
        {error && (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>⚠️ {error}</Text>
          </View>
        )}

        {loading ? (
          <ActivityIndicator color={colors.primary} style={styles.loader} />
        ) : documents.length === 0 ? (
          <Text style={styles.emptyText}>No documents found.</Text>
        ) : (
          ALL_CATEGORIES.map((cat) => {
            const items = grouped[cat];
            if (items.length === 0) return null;
            return (
              <View key={cat} style={styles.section}>
                <Text style={styles.sectionTitle}>
                  {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
                </Text>
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
                placeholderTextColor={colors.text.secondary}
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
                  onPress={() => {
                    setShowUpload(false);
                    setPickedFile(null);
                    setUploadDescription('');
                    setUploadCategory('other');
                  }}
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
                    <ActivityIndicator color={colors.surface} size="small" />
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
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  loader: {
    marginTop: spacing.xl,
  },
  emptyText: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  errorContainer: {
    padding: spacing.md,
    backgroundColor: colors.danger + '10',
    borderRadius: borderRadius.md,
    borderLeftWidth: 4,
    borderLeftColor: colors.danger,
    marginBottom: spacing.md,
  },
  errorText: {
    ...typography.body,
    color: colors.danger,
  },
  section: {
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  docCard: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  docInfo: {
    flex: 1,
    marginRight: spacing.sm,
  },
  docDescription: {
    ...typography.body,
    color: colors.text.primary,
    fontWeight: '600',
  },
  docDate: {
    ...typography.small,
    color: colors.text.secondary,
    marginTop: spacing.xs,
  },
  docActions: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  viewButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  viewButtonText: {
    ...typography.small,
    color: colors.surface,
    fontWeight: '600',
  },
  deleteButton: {
    backgroundColor: colors.danger + '15',
    borderRadius: borderRadius.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  deleteButtonText: {
    ...typography.small,
    color: colors.danger,
    fontWeight: '600',
  },
  // Upload panel
  uploadPanel: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    padding: spacing.md,
    paddingBottom: Platform.OS === 'ios' ? spacing.lg : spacing.md,
  },
  uploadButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  uploadButtonText: {
    ...typography.body,
    color: colors.surface,
    fontWeight: '600',
  },
  uploadForm: {
    gap: spacing.sm,
  },
  uploadLabel: {
    ...typography.caption,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  categoryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  categoryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.background,
  },
  categoryButtonActive: {
    borderColor: colors.primary,
    backgroundColor: colors.primary + '15',
  },
  categoryButtonIcon: {
    fontSize: 14,
  },
  categoryButtonText: {
    ...typography.small,
    color: colors.text.secondary,
  },
  categoryButtonTextActive: {
    color: colors.primary,
    fontWeight: '600',
  },
  descriptionInput: {
    ...typography.body,
    color: colors.text.primary,
    backgroundColor: colors.background,
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  pickerRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  pickerButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  pickerButtonText: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
  },
  pickedFileName: {
    ...typography.small,
    color: colors.success,
  },
  uploadActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  cancelButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  cancelButtonText: {
    ...typography.body,
    color: colors.text.secondary,
    fontWeight: '600',
  },
  confirmButton: {
    flex: 2,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  confirmButtonDisabled: {
    opacity: 0.6,
  },
  confirmButtonText: {
    ...typography.body,
    color: colors.surface,
    fontWeight: '600',
  },
});
