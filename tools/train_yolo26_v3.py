"""
Huấn luyện lại mô hình KHOANH VÙNG ống nghiệm (v3) để nhận được cả ảnh chụp điện thoại.

Vì sao cần: mô hình cũ chỉ học ảnh lab (ống thẳng đứng, nền giấy trắng, máy Canon),
nên gặp ảnh cầm tay / nền nhiều màu là khoanh nhầm (vd: khoanh cái ghế xanh thành "nắp").

Chuẩn bị:
  1) Trên web Plasma Grader: tải ảnh điện thoại lên (TẮT "Chỉ lưu phần ống nghiệm"),
     mở từng ảnh, sửa vùng khoanh cho đúng (nắp, headspace, plasma, hồng cầu).
  2) Quản trị -> "Xuất ảnh đã chỉnh tay" -> giải nén vào D:\\BME4\\DatasetWeb
  3) python train_yolo26_v3.py
  4) Báo Claude: file D:\\BME4\\Models\\tube-seg-v3.onnx sẽ được đưa lên web.

Mẹo: cần khoảng 100–200 ảnh điện thoại đã chỉnh tay, đủ kiểu nền / ánh sáng / góc nghiêng.
"""
import os, glob, shutil, json
from ultralytics import YOLO

# ================== CẤU HÌNH ==================
# (thư mục, bảng đổi số lớp cũ -> mới). Lớp không có trong bảng (vacutainer, buffycoat, sticker) bị bỏ.
DATASETS = [
    (r'D:\BME4\Datasetongnghiemroboflow', {1: 0, 2: 1, 3: 2, 4: 3}),   # ảnh lab cũ, 7 lớp
    (r'D:\BME4\DatasetWeb', None),                                     # ảnh xuất từ web, đã đúng 4 lớp
]
WEB_REPEAT = 3                  # ảnh điện thoại ít -> lặp lại 3 lần trong tập train cho mô hình chú ý hơn
OUT_DIR = r'D:\BME4\DatasetV3'
NAMES = ['cap', 'Headspace', 'plasma', 'bloodcell']
IMGSZ = 640                     # web tự đọc kích thước này từ meta.json
MODEL = 'yolo26n-seg.pt'        # máy mạnh có thể thử 'yolo26s-seg.pt'
DEVICE = 'cpu'                  # có GPU NVIDIA: 0
# ==============================================


def build_dataset():
    """Gộp các dataset thành OUT_DIR (copy file, ảnh web lặp WEB_REPEAT lần ở tập train)."""
    if os.path.isdir(OUT_DIR):
        shutil.rmtree(OUT_DIR)
    counts = {}
    for di, (src, remap) in enumerate(DATASETS):
        if not os.path.isdir(src):
            print(f'(bỏ qua, không thấy {src})')
            continue
        is_web = 'Web' in src
        for split in ('train', 'val'):
            imgs = [p for p in glob.glob(os.path.join(src, 'images', split, '*'))
                    if p.lower().endswith(('.jpg', '.jpeg', '.png', '.bmp', '.webp'))]
            if split == 'val' and not imgs:
                imgs = glob.glob(os.path.join(src, 'images', 'valid', '*'))
            for p in imgs:
                stem, ext = os.path.splitext(os.path.basename(p))
                lab = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(p))), 'labels',
                                   os.path.basename(os.path.dirname(p)), stem + '.txt')
                if not os.path.exists(lab):
                    continue
                with open(lab, encoding='utf-8') as f:
                    lines = [l.split() for l in f if l.strip()]
                if remap is not None:
                    lines = [[str(remap[int(l[0])])] + l[1:] for l in lines if int(l[0]) in remap]
                if not lines:
                    continue
                reps = WEB_REPEAT if (is_web and split == 'train') else 1
                for k in range(reps):
                    name = f'd{di}_{stem}_{k}'
                    for sub in ('images', 'labels'):
                        os.makedirs(os.path.join(OUT_DIR, sub, split), exist_ok=True)
                    shutil.copy(p, os.path.join(OUT_DIR, 'images', split, name + ext))
                    with open(os.path.join(OUT_DIR, 'labels', split, name + '.txt'), 'w', encoding='utf-8') as f:
                        f.write('\n'.join(' '.join(l) for l in lines) + '\n')
                counts[(src, split)] = counts.get((src, split), 0) + 1
    for (src, split), n in counts.items():
        print(f'  {os.path.basename(src):<14}{split:<6}{n} ảnh')
    yaml = os.path.join(OUT_DIR, 'data.yaml')
    with open(yaml, 'w', encoding='utf-8') as f:
        f.write(f"path: {OUT_DIR}\ntrain: images/train\nval: images/val\nnc: {len(NAMES)}\nnames: {NAMES}\n")
    return yaml


if __name__ == '__main__':
    data = build_dataset()
    model = YOLO(MODEL)
    model.train(
        data=data, epochs=200, patience=50, imgsz=IMGSZ, batch=4, device=DEVICE, workers=0,
        mask_ratio=2, overlap_mask=False, cos_lr=True, plots=True, name='ongnghiem_v3',
        # --- augmentation cho ảnh điện thoại: nghiêng, phối cảnh, nền lộn xộn, ánh sáng khác ---
        flipud=0.0,          # không lật dọc (nắp luôn ở trên)
        fliplr=0.5,
        degrees=25.0,        # ống cầm tay hay bị nghiêng
        perspective=0.0005,
        shear=2.0,
        translate=0.2,
        scale=0.5,           # ống to / nhỏ trong khung hình
        hsv_h=0.01,          # giữ nhỏ: màu huyết tương là thông tin quan trọng
        hsv_s=0.4,
        hsv_v=0.4,           # đèn sáng / tối khác nhau
        mosaic=1.0,          # ghép ảnh -> nhiều kiểu nền
        close_mosaic=30,
        copy_paste=0.3,      # dán ống sang nền khác
        erasing=0.2,
    )
    best = YOLO(model.trainer.best)
    m = best.val(data=data, imgsz=IMGSZ, device=DEVICE, workers=0, retina_masks=True)
    print(f"\nmAP50-95 (Mask): {m.seg.map:.3f}   mAP50 (Mask): {m.seg.map50:.3f}")

    # Xuất ONNX cho web
    os.makedirs(r'D:\BME4\Models', exist_ok=True)
    onnx = best.export(format='onnx', imgsz=IMGSZ, opset=17, simplify=True, dynamic=False)
    dst = r'D:\BME4\Models\tube-seg-v3.onnx'
    shutil.copy(onnx, dst)
    shutil.copy(model.trainer.best, r'D:\BME4\Models\best_v3.pt')
    with open(r'D:\BME4\Models\tube-seg-v3.meta.json', 'w', encoding='utf-8') as f:
        json.dump({'names': NAMES, 'imgsz': IMGSZ, 'nc': len(NAMES), 'nm': 32}, f)
    print(f'\nXong! Gửi Claude 2 file: {dst} và tube-seg-v3.meta.json để đưa lên web.')
