/**
 * mobile/services/api/profile.ts
 *
 * Profile-related API calls, including profile-picture upload.
 */

import apiClient from './client';
import API from './endpoints';

export interface AvatarUploadResponse {
  profile_picture_url: string;
}

/**
 * Upload a profile picture to Cloudinary via the backend.
 *
 * @param imageUri  Local file URI returned by expo-image-picker
 *                  (e.g. "file:///data/user/0/.../image.jpg")
 * @param mimeType  MIME type of the image (default: "image/jpeg")
 * @returns         The Cloudinary HTTPS URL of the stored image
 */
export const uploadAvatar = async (
  imageUri: string,
  mimeType: string = 'image/jpeg'
): Promise<AvatarUploadResponse> => {
  const fileName = imageUri.split('/').pop() ?? 'avatar.jpg';

  const formData = new FormData();
  formData.append('avatar', {
    uri: imageUri,
    name: fileName,
    type: mimeType,
  } as any);

  const response = await apiClient.post<AvatarUploadResponse>(
    API.USER.UPLOAD_AVATAR,
    formData,
    { headers: { 'Content-Type': 'multipart/form-data' } }
  );

  return response.data;
};
