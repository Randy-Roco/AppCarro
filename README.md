# AppCarro

**AppCarro** es una aplicación geomática 100% frontend para el **cálculo de coordenadas a partir de colimación**, orientada a trabajos de **geomensura, topografía y monitoreo de cuerpos de agua dinámicos**.

La app permite calibrar una cámara/estación usando puntos conocidos, calcular nuevos puntos desde ángulos y distancias observadas, gestionar **proyectos múltiples**, visualizar resultados sobre mapas (incluyendo **KMZ**) y exportar datos listos para **QGIS / ArcGIS**.

---

## 🚀 Características principales

### Geomensura
- Calibración por colimación:
  - ΔAH mediante **promedio circular**
  - ΔAV mediante promedio aritmético
- Convención angular:
  - **AH**: `0° = Norte (+Y), 90° = Este (+X)`
  - **AV**: inclinación respecto a la horizontal
- Cálculo de coordenadas XYZ desde:
  - Ángulo horizontal
  - Ángulo vertical
  - Distancia inclinada

### Proyectos
- Gestión de **proyectos múltiples**
- Crear, duplicar, eliminar proyectos
- Persistencia local mediante **localStorage**
- Exportar / importar proyectos completos (`.json`)
- Ideal para **campañas repetidas** (lagunas dinámicas, monitoreo temporal)

### GIS & Visualización
- Sistema de referencia por defecto: **EPSG:32719 (UTM 19S)**
- Mini-mapa integrado:
  - Vista por extents (UTM)
  - Imagen raster + world file
  - **KMZ con GroundOverlay**
- Reproyección automática UTM → WGS84 para visualización KMZ

### Exportaciones
- TXT (personalizable: separador y decimal)
- CSV
- **GeoJSON** (listo para QGIS / ArcGIS)
- Proyecto completo (`.json`)

---

## 🧱 Arquitectura

- **100% frontend estático**
- No requiere backend ni servidor
- Compatible con:
  - GitHub Pages
  - Vercel
  - Uso offline (una vez cargada)

### Tecnologías
- HTML5
- CSS3 (UI técnica, jerárquica)
- JavaScript (Vanilla)
- Librerías externas:
  - `proj4` (reproyección CRS)
  - `JSZip` (lectura de KMZ)

---

## 📁 Estructura del proyecto
AppCarro/
├── index.html
├── styles.css
├── app.js
├── config.json
├── assets/
│ ├── csv.png
│ ├── shp.png
│ ├── txt.png
│ └── xml.png
└── README.md

## Autor

Desarrollado por Randy Roco
Ingeniero en Geomensura
Enfoque: Geomática aplicada, topografía y análisis espacial
