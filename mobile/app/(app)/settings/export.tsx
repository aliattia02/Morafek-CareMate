/**
 * Data Export Screen (GDPR Compliance)
 * Location: mobile/app/(app)/settings/export.tsx
 *
 * Main Function: ExportScreen
 * Description: GDPR-compliant data export functionality allowing patients to download all their health data
 *
 * Features:
 * - Export all patient health data (glucose, meals, insulin, activities)
 * - GDPR compliance information display
 * - Data portability rights explanation
 * - JSON format export
 * - Account deletion request option
 * - Export status tracking
 * - Email notification for download readiness
 * - Privacy rights documentation
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

// Components
import { Card, Button } from '@/components/ui';

// Services
import apiClient from '@/services/api/client';
import API from '@/services/api/endpoints';

// Constants
import { colors, spacing, typography, borderRadius } from '@/constants/theme';

export default function ExportScreen() {
  const [isExporting, setIsExporting] = useState(false);

  const handleExport = async () => {
    Alert.alert(
      'Export Data',
      'This will prepare all your health data for download. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Export',
          onPress: async () => {
            setIsExporting(true);
            try {
              // In a real implementation, this would trigger a data export
              // and provide a download link or send the data via email
              const response = await apiClient.get(API.EXPORT.PATIENT_DATA);
              Alert.alert(
                'Export Initiated',
                'Your data export is being prepared. You will receive an email when it\'s ready for download.'
              );
            } catch (error) {
              Alert.alert(
                'Export Failed',
                'Unable to export data at this time. Please try again later.'
              );
            } finally {
              setIsExporting(false);
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Info Card */}
        <Card variant="elevated" padding="large" style={styles.infoCard}>
          <Text style={styles.icon}>📤</Text>
          <Text style={styles.title}>Export Your Data</Text>
          <Text style={styles.description}>
            In compliance with GDPR and DiGA requirements, you can export all your personal health data at any time.
          </Text>
        </Card>

        {/* What's Included */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>What's Included</Text>
          <View style={styles.includesList}>
            <View style={styles.includeItem}>
              <Text style={styles.includeBullet}>✓</Text>
              <Text style={styles.includeText}>Blood glucose readings and history</Text>
            </View>
            <View style={styles.includeItem}>
              <Text style={styles.includeBullet}>✓</Text>
              <Text style={styles.includeText}>Meal logs and nutrition data</Text>
            </View>
            <View style={styles.includeItem}>
              <Text style={styles.includeBullet}>✓</Text>
              <Text style={styles.includeText}>Insulin doses and schedules</Text>
            </View>
            <View style={styles.includeItem}>
              <Text style={styles.includeBullet}>✓</Text>
              <Text style={styles.includeText}>Activity records</Text>
            </View>
            <View style={styles.includeItem}>
              <Text style={styles.includeBullet}>✓</Text>
              <Text style={styles.includeText}>Personal settings and constants</Text>
            </View>
            <View style={styles.includeItem}>
              <Text style={styles.includeBullet}>✓</Text>
              <Text style={styles.includeText}>Account information</Text>
            </View>
          </View>
        </Card>

        {/* Export Format */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.sectionTitle}>Export Format</Text>
          <Text style={styles.formatText}>
            Your data will be exported in JSON format, which can be opened with any text editor or imported into other health applications.
          </Text>
        </Card>

        {/* Export Button */}
        <Button
          title="Export All My Data"
          onPress={handleExport}
          loading={isExporting}
          fullWidth
          style={styles.exportButton}
        />

        {/* GDPR Info */}
        <Card variant="filled" padding="medium" style={styles.gdprCard}>
          <Text style={styles.gdprTitle}>Your Rights Under GDPR</Text>
          <Text style={styles.gdprText}>
            Under the General Data Protection Regulation, you have the right to:
          </Text>
          <View style={styles.gdprList}>
            <Text style={styles.gdprItem}>• Access your personal data</Text>
            <Text style={styles.gdprItem}>• Receive a copy of your data (data portability)</Text>
            <Text style={styles.gdprItem}>• Request correction of inaccurate data</Text>
            <Text style={styles.gdprItem}>• Request deletion of your data</Text>
            <Text style={styles.gdprItem}>• Withdraw consent at any time</Text>
          </View>
        </Card>

        {/* Delete Account Option */}
        <Card variant="outlined" padding="medium" style={styles.section}>
          <Text style={styles.deleteTitle}>Delete Account</Text>
          <Text style={styles.deleteText}>
            If you wish to delete your account and all associated data, please contact our support team or your healthcare provider.
          </Text>
          <Button
            title="Request Account Deletion"
            variant="danger"
            onPress={() => Alert.alert(
              'Delete Account',
              'To delete your account, please contact support@native-diabetes.com with your request.',
              [{ text: 'OK' }]
            )}
            style={styles.deleteButton}
          />
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

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
  infoCard: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  icon: {
    fontSize: 48,
    marginBottom: spacing.md,
  },
  title: {
    ...typography.h2,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  description: {
    ...typography.body,
    color: colors.text.secondary,
    textAlign: 'center',
  },
  section: {
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.h3,
    color: colors.text.primary,
    marginBottom: spacing.sm,
  },
  includesList: {
    gap: spacing.sm,
  },
  includeItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  includeBullet: {
    color: colors.success,
    fontWeight: 'bold',
    marginRight: spacing.sm,
    fontSize: 16,
  },
  includeText: {
    ...typography.body,
    color: colors.text.primary,
    flex: 1,
  },
  formatText: {
    ...typography.body,
    color: colors.text.secondary,
  },
  exportButton: {
    marginBottom: spacing.lg,
  },
  gdprCard: {
    backgroundColor: colors.primary + '10',
    marginBottom: spacing.md,
  },
  gdprTitle: {
    ...typography.body,
    color: colors.primary,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  gdprText: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.sm,
  },
  gdprList: {
    paddingLeft: spacing.sm,
  },
  gdprItem: {
    ...typography.small,
    color: colors.text.secondary,
    marginBottom: 4,
  },
  deleteTitle: {
    ...typography.h3,
    color: colors.danger,
    marginBottom: spacing.sm,
  },
  deleteText: {
    ...typography.body,
    color: colors.text.secondary,
    marginBottom: spacing.md,
  },
  deleteButton: {
    alignSelf: 'flex-start',
  },
});