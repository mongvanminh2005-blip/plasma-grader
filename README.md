# Plasma Grader (bản miễn phí: GitHub Pages + Supabase)

Website phân độ đậm đặc huyết tương 0–5. Giao diện chạy trên GitHub Pages,
tài khoản / dữ liệu / ảnh lưu trên Supabase (gói Free).

## Các file
| File | Vai trò |
|---|---|
| `index.html`, `style.css`, `app.js` | Giao diện website |
| `config.js` | **Nơi dán địa chỉ + khoá Supabase của bạn** |
| `setup.sql` | Tạo bảng, bảo mật, kho ảnh – chạy 1 lần trong Supabase |

## Cài đặt (tóm tắt)
1. Supabase: tạo project → SQL Editor → dán `setup.sql` → Run.
2. Supabase: Authentication → Sign In / Providers → Email → tắt "Confirm email" (nếu không muốn xác nhận qua email).
3. Supabase: Project Settings → API → copy Project URL và anon/publishable key vào `config.js`.
4. GitHub: tạo repo **Public**, tải toàn bộ file lên.
5. GitHub: Settings → Pages → Deploy from a branch → `main` / `(root)` → Save.
6. Supabase: Authentication → URL Configuration → Site URL = địa chỉ GitHub Pages.

## Giới hạn gói miễn phí Supabase
- Lưu ảnh 1 GB, CSDL 500 MB (ảnh được nén ~1600px khi tải lên để tiết kiệm).
- Project bị tạm dừng nếu ~7 ngày không có hoạt động → vào Supabase bấm Restore.
- Không có sao lưu tự động: thỉnh thoảng bấm "Xuất tất cả CSV" để lưu kết quả.

Khoá anon/publishable được thiết kế để công khai; dữ liệu được bảo vệ bởi các chính sách
Row Level Security trong `setup.sql` (mỗi tài khoản chỉ đọc/sửa dữ liệu của mình).

## Khoanh vùng AI (nắp / headspace / plasma / hồng cầu)
- Mô hình: YOLO26n-seg (Ultralytics) xuất sang ONNX → `model/tube-seg.onnx`, chạy trong trình duyệt bằng onnxruntime-web (`seg.js`).
- Kết quả lưu ở cột `images.regions` (đa giác, toạ độ chuẩn hoá 0..1), `regions_source` = `ai` | `manual`.
- Cập nhật mô hình mới: `yolo export model=best.pt format=onnx imgsz=416 opset=17 simplify=True`,
  đổi tên thành `model/tube-seg.onnx`, sửa `names` trong `model/meta.json` nếu đổi lớp, tăng `?v=` trong `seg.js`.

## Bảo mật
- Tài khoản mới phải được quản trị viên **duyệt** (Quản trị → ✓ Duyệt) mới xem/tải/chấm ảnh; có thể **khoá** tài khoản (đăng xuất mọi thiết bị). Xem `security.sql`.
- Mọi bảng đều bật Row Level Security; quyền thừa (TRUNCATE…) đã thu hồi; kho ảnh chỉ nhận file ảnh ≤ 30 MB.
- Mật khẩu mới: ≥ 8 ký tự, có chữ và số, không chứa tên đăng nhập. Tự đăng xuất sau 30 phút nếu không chọn "Ghi nhớ đăng nhập".
- Thư viện được lưu trong `vendor/` (không tải từ CDN) và kiểm tra bằng mã băm SRI; Content-Security-Policy chỉ cho phép mã từ chính trang này và kết nối tới Supabase của dự án.
- Chặn nhúng trang vào iframe, chặn chèn công thức khi mở CSV bằng Excel, link ảnh riêng tư hết hạn sau 2 giờ.

## Thùng rác, sao lưu, chỉ số đồng thuận
- Xoá ảnh / lô chỉ chuyển vào **Thùng rác** (thanh bên), khôi phục được trong 30 ngày; quá hạn website tự xoá hẳn. Xem `trash.sql`.
- **Quản trị → Sao lưu**: tải ZIP gồm `data.json` (toàn bộ dữ liệu), `ket-qua.csv`, và tuỳ chọn toàn bộ ảnh.
- **Tổng kết**: số ảnh đã phân loại, số người phân loại, mức đồng thuận, phân bố độ theo từng người, danh sách ảnh được phân loại khác nhau.
