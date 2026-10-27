import { Router } from 'express';
import upload from '../common/middlewares/multer';
import { uploadFiles } from './file.controller';

const router = Router();

// 이미지 업로드
router.post('/', upload.array('files'), uploadFiles);

export default router;
